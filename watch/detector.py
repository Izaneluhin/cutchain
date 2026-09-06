"""Chat velocity, hot words, clip pressure and spike detection.

The detector is clock-agnostic: callers feed messages (each carrying its own
timestamp) and call ``tick(now)`` once per second. Live mode ticks with the
wall clock; replay mode ticks with a virtual clock derived from the log.
"""

from __future__ import annotations

import itertools
import math
import re
from collections import Counter, deque
from dataclasses import dataclass, field
from typing import Any, Callable

from .models import ChatMessage, Moment, iso

# Function words plus a handful of ultra-generic chat fillers. Emotes and slang
# ("kekw", "lmao", "cooked") are deliberately *not* here: they are the signal.
STOPWORDS: frozenset[str] = frozenset(
    """
    the and for are but not you your yours all any can had has have him his her
    hers she they them their this that these those was were will with what when
    where who whom why how from into onto out over under then than too very just
    like get got gets its it's i'm im ive i've dont don't cant can't didnt didn't
    isnt isn't wasnt wasn't thats that's there here about after before again
    also because been being does doing done each few more most much some such
    only other same still than upon while would could should shall might must
    one two ten yes yeah yea yep nah nope ok okay lol bro man guy guys
    he's she's what's who's there's let's we're they're you're i'll we'll he'll
    i'd i've we've you've won't wouldn't couldn't shouldn't ain't gonna wanna
    """.split()
)

TOKEN_RE = re.compile(r"[A-Za-z0-9_']+")
MENTION_RE = re.compile(r"@\w+")
CLIP_RE = re.compile(r"\bclip(?:s|it|ped|per|pers|ping)?\b", re.IGNORECASE)
ACTION_RE = re.compile(r"^\x01ACTION (.*)\x01$")


@dataclass(frozen=True, slots=True)
class Thresholds:
    min_rate: int = 12  # msgs per rate_window_s
    spike_factor: float = 3.0  # rate must be >= spike_factor * baseline
    clip_threshold: int = 5  # clip requests in hot_window_s
    cooldown_s: float = 120.0  # per channel, after a moment fires
    warmup_s: float = 30.0  # no moments before the channel has this much history
    rate_window_s: float = 10.0
    hot_window_s: float = 30.0
    baseline_tau_s: float = 300.0  # EMA time constant (5 minutes)
    peak_track_s: float = 10.0  # keep refining a fired moment's stats this long
    top_n: int = 5
    sample_n: int = 5

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "Thresholds":
        if not data:
            return cls()
        allowed = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        clean = {k: v for k, v in data.items() if k in allowed and v is not None}
        return cls(**clean)


def tokenize(text: str) -> list[str]:
    """Lowercase word tokens with punctuation stripped; drops stopwords,
    1-2 char tokens, pure numbers and @mentions. Emote-like tokens survive."""
    out: list[str] = []
    for raw in TOKEN_RE.findall(MENTION_RE.sub(" ", text)):
        tok = raw.strip("'_").lower()
        if len(tok) <= 2 or tok in STOPWORDS or tok.isdigit():
            continue
        out.append(tok)
    return out


def is_clip_request(text: str) -> bool:
    return CLIP_RE.search(text) is not None


def strip_action(text: str) -> str:
    """Twitch '/me' messages arrive as CTCP ACTION; unwrap them."""
    m = ACTION_RE.match(text)
    return m.group(1) if m else text


@dataclass(slots=True)
class LiveStats:
    platform: str
    channel: str
    rate: int = 0
    baseline: float = 0.0
    clip_pressure: int = 0
    top_words: list[str] = field(default_factory=list)
    last_message_ts: float | None = None
    msgs_total: int = 0
    threshold: float = 0.0
    warmed_up: bool = False
    cooldown_left_s: float = 0.0
    moments: int = 0
    updated_ts: float | None = None

    @property
    def key(self) -> str:
        return f"{self.platform}/{self.channel}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "platform": self.platform,
            "channel": self.channel,
            "rate": self.rate,
            "baseline": round(self.baseline, 2),
            "clip_pressure": self.clip_pressure,
            "top_words": list(self.top_words),
            "last_message_ts": iso(self.last_message_ts),
            "msgs_total": self.msgs_total,
            "threshold": round(self.threshold, 2),
            "warmed_up": self.warmed_up,
            "cooldown_left_s": round(self.cooldown_left_s, 1),
            "moments": self.moments,
            "updated_ts": iso(self.updated_ts),
        }


class ChannelWindow:
    """Sliding windows for one channel. Keeps the last ``hot_window_s`` of
    messages; the 10 s rate window is a sub-range of that deque."""

    def __init__(self, platform: str, channel: str, th: Thresholds) -> None:
        self.th = th
        self.stats = LiveStats(platform=platform, channel=channel)
        self.msgs: deque[ChatMessage] = deque()
        self.first_seen: float | None = None
        self.baseline: float | None = None  # None until seeded
        self.last_tick: float | None = None
        self.last_fire: float | None = None
        self.active: Moment | None = None  # fired, still being peak-tracked

    # -- ingest -----------------------------------------------------------
    def add(self, msg: ChatMessage) -> None:
        if self.first_seen is None:
            self.first_seen = msg.ts
        self.msgs.append(msg)
        self.stats.msgs_total += 1
        if self.stats.last_message_ts is None or msg.ts > self.stats.last_message_ts:
            self.stats.last_message_ts = msg.ts

    def observe(self, now: float) -> None:
        """Mark that the channel is being watched even with no traffic yet."""
        if self.first_seen is None:
            self.first_seen = now

    def prune(self, now: float) -> None:
        cutoff = now - self.th.hot_window_s
        while self.msgs and self.msgs[0].ts < cutoff:
            self.msgs.popleft()

    # -- measurements -----------------------------------------------------
    def hot_window(self, now: float) -> list[ChatMessage]:
        """Messages in the last ``hot_window_s`` up to ``now`` (never later)."""
        return [m for m in self.msgs if m.ts <= now]

    def rate(self, now: float, window: list[ChatMessage] | None = None) -> int:
        cutoff = now - self.th.rate_window_s
        msgs = window if window is not None else self.hot_window(now)
        return sum(1 for m in msgs if m.ts > cutoff)

    def clip_pressure(self, window: list[ChatMessage]) -> int:
        return sum(1 for m in window if is_clip_request(m.text))

    def top_words(self, window: list[ChatMessage]) -> list[str]:
        counts: Counter[str] = Counter()
        for m in window:
            counts.update(set(tokenize(m.text)))  # once per message
        return [w for w, _ in counts.most_common(self.th.top_n)]

    def samples(self, window: list[ChatMessage]) -> list[str]:
        recent = window[-self.th.sample_n :]
        return [f"{m.user}: {m.text}" for m in reversed(recent)]

    def update_baseline(self, now: float, rate: int) -> float:
        """5-minute EMA of the 10 s rate, seeded with the first full window."""
        if self.baseline is None:
            age = now - (self.first_seen if self.first_seen is not None else now)
            if age >= self.th.rate_window_s:
                self.baseline = float(rate)
            self.last_tick = now
            return self.baseline if self.baseline is not None else 0.0
        dt = max(0.0, now - (self.last_tick if self.last_tick is not None else now))
        alpha = 1.0 - math.exp(-dt / self.th.baseline_tau_s) if dt > 0 else 0.0
        self.baseline += alpha * (rate - self.baseline)
        self.last_tick = now
        return self.baseline

    def warmed_up(self, now: float) -> bool:
        return self.first_seen is not None and now - self.first_seen >= self.th.warmup_s

    def in_cooldown(self, now: float) -> bool:
        return self.last_fire is not None and now - self.last_fire < self.th.cooldown_s


class Detector:
    """Owns one ChannelWindow per channel plus the ``live`` snapshot."""

    def __init__(
        self,
        thresholds: Thresholds | None = None,
        next_id: Callable[[], int] | None = None,
    ) -> None:
        self.th = thresholds or Thresholds()
        self._next_id = next_id or itertools.count(1).__next__
        self._windows: dict[str, ChannelWindow] = {}
        self.live: dict[str, LiveStats] = {}

    # -- channel registry -------------------------------------------------
    def register(self, platform: str, channel: str) -> ChannelWindow:
        key = f"{platform}/{channel}"
        win = self._windows.get(key)
        if win is None:
            win = ChannelWindow(platform, channel, self.th)
            self._windows[key] = win
            self.live[key] = win.stats
        return win

    def feed(self, msg: ChatMessage) -> None:
        msg.text = strip_action(msg.text)
        self.register(msg.platform, msg.channel).add(msg)

    # -- per-second evaluation --------------------------------------------
    def tick(self, now: float) -> tuple[list[Moment], list[Moment]]:
        """Returns ``(fired, finalized)``: moments that fired on this tick and
        moments whose peak-tracking window just ended (stats are final)."""
        fired: list[Moment] = []
        finalized: list[Moment] = []
        for win in self._windows.values():
            win.observe(now)
            win.prune(now)
            window = win.hot_window(now)
            done = self._track_peak(win, now, window)
            if done is not None:
                finalized.append(done)
            moment = self._tick_channel(win, now, window)
            if moment is not None:
                fired.append(moment)
                win.active = moment
        return fired, finalized

    def flush(self) -> list[Moment]:
        """Finalize every moment still being tracked (used at shutdown)."""
        out: list[Moment] = []
        for win in self._windows.values():
            if win.active is not None:
                out.append(win.active)
                win.active = None
        return out

    def _track_peak(self, win: ChannelWindow, now: float, window: list[ChatMessage]) -> Moment | None:
        """For ``peak_track_s`` after firing, keep the moment's stats at their
        peak so the stored record describes the spike, not just its onset."""
        m = win.active
        if m is None:
            return None
        if now - m.ts >= self.th.peak_track_s:
            win.active = None
            return m
        m.rate = max(m.rate, win.rate(now, window))
        m.clip_pressure = max(m.clip_pressure, win.clip_pressure(window))
        m.top_words = win.top_words(window)[:5]
        m.sample_messages = win.samples(window)[:5]
        return None

    def _tick_channel(self, win: ChannelWindow, now: float, window: list[ChatMessage]) -> Moment | None:
        rate = win.rate(now, window)
        baseline = win.update_baseline(now, rate)
        pressure = win.clip_pressure(window)
        top = win.top_words(window)
        threshold = max(float(self.th.min_rate), self.th.spike_factor * baseline)

        st = win.stats
        st.rate, st.baseline, st.clip_pressure, st.top_words = rate, baseline, pressure, top
        st.threshold = threshold
        st.warmed_up = win.warmed_up(now)
        st.cooldown_left_s = (
            max(0.0, self.th.cooldown_s - (now - win.last_fire)) if win.last_fire else 0.0
        )
        st.updated_ts = now

        if not st.warmed_up or win.in_cooldown(now):
            return None
        by_rate = rate >= threshold
        by_clip = pressure >= self.th.clip_threshold
        if not (by_rate or by_clip):
            return None

        win.last_fire = now
        st.moments += 1
        reason = "spike+clip_pressure" if by_rate and by_clip else ("spike" if by_rate else "clip_pressure")
        return Moment(
            id=self._next_id(),
            ts=now,
            platform=st.platform,
            channel=st.channel,
            rate=rate,
            baseline=baseline,
            clip_pressure=pressure,
            top_words=top[:5],
            sample_messages=win.samples(window)[:5],
            reason=reason,
        )
