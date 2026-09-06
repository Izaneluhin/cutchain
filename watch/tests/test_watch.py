"""Offline checks for the IRC parser, Kick event parser and detector.

Run from the repo root:  python -m watch.tests.test_watch   (or pytest watch/tests)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from watch.detector import Detector, Thresholds, is_clip_request, tokenize  # noqa: E402
from watch.kick import parse_chat_event  # noqa: E402
from watch.models import ChatMessage  # noqa: E402
from watch.twitch import parse_irc_line, privmsg_to_chat  # noqa: E402

PRIVMSG = (
    "@badge-info=;badges=;color=#FF0000;display-name=Mogger_7;emotes=;first-msg=0;id=abc;"
    "mod=0;room-id=1;subscriber=0;tmi-sent-ts=1788638400123;turbo=0;user-id=2;user-type= "
    ":mogger_7!mogger_7@mogger_7.tmi.twitch.tv PRIVMSG #Clavicular :CLIP IT :) lol"
)


def test_irc_parse() -> None:
    irc = parse_irc_line(PRIVMSG)
    assert irc is not None and irc.command == "PRIVMSG"
    assert irc.params == ["#Clavicular", "CLIP IT :) lol"]
    msg = privmsg_to_chat(irc)
    assert msg is not None
    assert (msg.channel, msg.user, msg.text) == ("clavicular", "Mogger_7", "CLIP IT :) lol")
    assert privmsg_to_chat(irc, now=5.0).ts == 5.0  # type: ignore[union-attr]
    ping = parse_irc_line("PING :tmi.twitch.tv")
    assert ping is not None and ping.command == "PING" and ping.params == ["tmi.twitch.tv"]
    assert parse_irc_line(":tmi.twitch.tv RECONNECT").command == "RECONNECT"  # type: ignore[union-attr]


def test_kick_parse() -> None:
    payload = {
        "event": "App\\Events\\ChatMessageEvent",
        "data": json.dumps({"id": "x", "chatroom_id": 42, "content": "clip that", "type": "message",
                            "created_at": "2026-09-05T20:00:00+00:00", "sender": {"id": 1, "username": "adin_fan"}}),
        "channel": "chatrooms.42.v2",
    }
    msg = parse_chat_event(payload, {42: "adinross"}, now=7.0)
    assert msg is not None and msg.platform == "kick" and msg.channel == "adinross"
    assert msg.user == "adin_fan" and msg.text == "clip that" and msg.ts == 7.0
    assert parse_chat_event({"event": "pusher:ping", "data": {}}, {}) is None


def test_tokens_and_clip_words() -> None:
    assert tokenize("He's COOKED!! KEKW, the fight lmao @mogger_7 W 12") == ["cooked", "kekw", "fight", "lmao"]
    for text in ("clip", "CLIP IT", "clipped", "clipper where u at", "someone clip that"):
        assert is_clip_request(text), text
    assert not is_clip_request("eclipse paperclip")


def _run(det: Detector, t0: float, seconds: int, per_10s: float, channel: str = "c") -> list:
    """Feed ``per_10s`` messages per 10 s and tick every second, like live mode."""
    gap = 10.0 / per_10s
    fired = []
    next_msg = t0
    for s in range(seconds):
        now = t0 + s
        while next_msg < now + 1:
            det.feed(ChatMessage("twitch", channel, "u", "hi chat", next_msg))
            next_msg += gap
        fired += det.tick(now)[0]
    return fired


def test_spike_fires_once_with_cooldown() -> None:
    det = Detector(Thresholds(min_rate=12, spike_factor=3.0, cooldown_s=120, warmup_s=30))
    det.register("twitch", "c")
    t0 = 1000.0
    fired = _run(det, t0, 120, 4)
    assert fired == [], "baseline traffic must not fire"
    assert 3.0 <= det.live["twitch/c"].baseline <= 5.0
    fired = _run(det, t0 + 120, 30, 40)
    assert len(fired) == 1, fired
    m = fired[0]
    assert m.reason == "spike" and m.rate >= 12 and m.channel == "c"
    assert det.live["twitch/c"].cooldown_left_s > 0
    assert m.rate >= 35, "peak tracking should have raised the recorded rate"
    assert det.flush() == [], "moment was finalized during the run"


def test_clip_pressure_fires() -> None:
    det = Detector(Thresholds(clip_threshold=5, warmup_s=0))
    t0 = 0.0
    for i in range(5):
        det.feed(ChatMessage("twitch", "c", f"u{i}", "CLIP IT", t0 + i))
    fired = []
    for s in range(0, 11):
        fired += det.tick(t0 + s)[0]
    assert len(fired) == 1 and fired[0].reason == "clip_pressure" and fired[0].clip_pressure == 5
    assert fired[0].ts == 4.0, "fires on the tick where the 5th clip request becomes visible"


def test_big_channel_does_not_fire_at_startup() -> None:
    det = Detector(Thresholds())
    fired = _run(det, 0.0, 90, 100)  # 100 msgs / 10 s steady
    assert fired == [], "steady high traffic is the baseline, not a spike"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
