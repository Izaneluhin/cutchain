"""Entry point: ``python -m watch [--twitch a,b] [--kick c] [--replay log]``."""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
import time
from dataclasses import asdict
from typing import Any

from . import __version__
from .api import build_app, start_api
from .clip import Clipper, clipper_from_env
from .config import Settings, build_settings, load_dotenv
from .console import fmt_clip_result, fmt_final, fmt_moment, fmt_status
from .detector import Detector
from .kick import KICK_PUSHER_URL, KickChat
from .models import ChatMessage, Moment
from .replay import Recorder, replay_log
from .store import MomentStore
from .twitch import TWITCH_IRC_URL, TwitchChat

log = logging.getLogger("watch")


def setup_logging(level: str) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s", "%H:%M:%S"))
    logging.basicConfig(level=getattr(logging, level, logging.INFO), handlers=[handler])
    logging.getLogger("websockets").setLevel(logging.WARNING)
    logging.getLogger("aiohttp").setLevel(logging.WARNING)


def out(text: str) -> None:
    print(text, flush=True)


class Watcher:
    """Wires chat sources -> detector -> clipper/store -> console/API."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.store = MomentStore(settings.data_dir)
        self.detector = Detector(settings.thresholds, next_id=self.store.next_id)
        self.clipper: Clipper = clipper_from_env(os.environ)
        self.recorder = Recorder(settings.record) if settings.record else None
        self.twitch: TwitchChat | None = None
        self.kick: KickChat | None = None
        self.mode = "replay" if settings.replay else "live"
        self._last_status_at = 0.0
        self._pending: set[asyncio.Task[None]] = set()
        self._clip_tasks: dict[int, asyncio.Task[None]] = {}
        self.moments_fired = 0

    # -- ingest -----------------------------------------------------------
    def on_message(self, msg: ChatMessage) -> None:
        self.detector.feed(msg)
        if self.recorder is not None:
            self.recorder.write(msg)

    async def tick(self, now: float) -> None:
        fired, finalized = self.detector.tick(now)
        for moment in fired:
            self.on_fire(moment)
        for moment in finalized:
            self._spawn(self.finalize(moment))
        if now - self._last_status_at >= self.settings.status_every - 1e-6:
            self._last_status_at = now
            for stats in self.detector.live.values():
                out(fmt_status(stats, now, self.settings.thresholds.rate_window_s))

    def _spawn(self, coro: Any) -> asyncio.Task[None]:
        task: asyncio.Task[None] = asyncio.create_task(coro)
        self._pending.add(task)
        task.add_done_callback(self._pending.discard)
        return task

    # -- moment lifecycle: fire (clip now) -> peak-track 10 s -> finalize ----
    def on_fire(self, moment: Moment) -> None:
        self.moments_fired += 1
        out(fmt_moment(moment))
        self.store.upsert(moment)  # visible on /api/moments immediately
        self._clip_tasks[moment.id] = self._spawn(self.attempt_clip(moment))

    async def attempt_clip(self, moment: Moment) -> None:
        """Twitch clips capture the ~90 s *before* the call, so this runs the
        instant a moment fires rather than after peak tracking."""
        if moment.platform != "twitch":
            moment.status = "detected"
            log.info("clip skipped (%s has no clip API)", moment.platform)
        elif not self.clipper.enabled:
            moment.status = "detected"
            await self.clipper.create_clip(moment.channel)  # logs "clip skipped (no TWITCH_TOKEN)"
        elif self.mode == "replay":
            moment.status, moment.error = "detected", "replay mode: clips are only created live"
            log.info("clip skipped (replay mode) for %s", moment.key)
        else:
            moment.status = "clipping"
            self.store.upsert(moment)
            result = await self.clipper.create_clip(moment.channel)
            if result is not None:
                moment.clip_id, moment.edit_url, moment.clip_url = result.id, result.edit_url, result.clip_url
                moment.status = "clipped"
            else:
                moment.status, moment.error = "clip_failed", "helix clip request failed (see log)"
        self.store.upsert(moment)
        out(fmt_clip_result(moment))

    async def finalize(self, moment: Moment) -> None:
        """Peak tracking is over: wait for the clip attempt, then write the
        single JSONL line and the final SQLite row."""
        task = self._clip_tasks.pop(moment.id, None)
        if task is not None:
            await asyncio.gather(task, return_exceptions=True)
        self.store.save(moment)
        out(fmt_final(moment))

    async def drain(self) -> None:
        """Finalize moments still being tracked and wait for pending tasks."""
        for moment in self.detector.flush():
            self._spawn(self.finalize(moment))
        while self._pending:
            await asyncio.gather(*list(self._pending), return_exceptions=True)

    # -- run modes --------------------------------------------------------
    async def ticker(self) -> None:
        while True:
            await self.tick(time.time())
            await asyncio.sleep(1.0)

    def api_info(self) -> dict[str, Any]:
        return {
            "version": __version__,
            "mode": self.mode,
            "clips_enabled": self.clipper.enabled,
            "twitch_channels": self.settings.twitch_channels,
            "kick_channels": self.settings.kick_channels,
            "kick_status": self.kick.status if self.kick else "disabled",
            "thresholds": asdict(self.settings.thresholds),
        }

    async def run_live(self, stop: asyncio.Event) -> None:
        s = self.settings
        for channel in s.twitch_channels:
            self.detector.register("twitch", channel)
        for slug in s.kick_channels:
            self.detector.register("kick", slug)
        self.twitch = TwitchChat(s.twitch_channels, self.on_message, url=s.twitch_irc_url or TWITCH_IRC_URL)
        self.kick = KickChat(s.kick_channels, self.on_message, s.kick_chatroom_ids, url=s.kick_pusher_url or KICK_PUSHER_URL)
        tasks = [asyncio.create_task(self.twitch.run(), name="twitch"),
                 asyncio.create_task(self.kick.run(), name="kick"),
                 asyncio.create_task(self.ticker(), name="ticker")]
        try:
            await stop.wait()
        finally:
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def run_replay(self, stop: asyncio.Event) -> None:
        s = self.settings
        assert s.replay is not None
        fed = await replay_log(s.replay, s.speed, self.on_message, self.tick)
        await self.drain()
        out(f"--- replay finished: {fed} messages, {self.moments_fired} moment(s) fired, "
            f"{self.store.count()} in {self.store.db_path.name} ---")
        if not s.once and not stop.is_set():
            log.info("API still serving on port %d; press Ctrl+C to exit (or use --once)", s.port)
            await stop.wait()

    async def run(self) -> None:
        s = self.settings
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, stop.set)
            except NotImplementedError:  # Windows
                pass
        runner = await start_api(build_app(self.detector, self.store, self.api_info), s.host, s.port)
        try:
            if self.mode == "replay":
                await self.run_replay(stop)
            else:
                await self.run_live(stop)
        finally:
            await self.drain()
            await runner.cleanup()
            await self.clipper.close()
            if self.recorder:
                self.recorder.close()
            self.store.close()
            log.info("bye (%d moment(s) this session)", self.moments_fired)


def describe(settings: Settings) -> str:
    th = settings.thresholds
    parts = [
        f"watch {__version__}",
        f"mode={'replay ' + str(settings.replay) if settings.replay else 'live'}",
        f"twitch={','.join(settings.twitch_channels) or '-'}",
        f"kick={','.join(settings.kick_channels) or '-'}",
        f"min_rate={th.min_rate} spike_factor={th.spike_factor} clip_threshold={th.clip_threshold} "
        f"cooldown={th.cooldown_s:.0f}s warmup={th.warmup_s:.0f}s",
        f"data={settings.data_dir}",
    ]
    if settings.config_path:
        parts.append(f"config={settings.config_path}")
    if settings.record:
        parts.append(f"record={settings.record}")
    return " | ".join(parts)


def main(argv: list[str] | None = None) -> int:
    load_dotenv()
    settings = build_settings(argv)
    setup_logging(settings.log_level)
    if not settings.replay and not settings.twitch_channels and not settings.kick_channels:
        log.error("nothing to watch: pass --twitch/--kick or set channels in config.yaml")
        return 2
    log.info(describe(settings))
    try:
        asyncio.run(Watcher(settings).run())
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
