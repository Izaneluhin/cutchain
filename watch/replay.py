"""Record chat to a JSONL log and replay it through the detector.

Log format: one JSON object per line ``{"ts", "platform", "channel", "user",
"text"}`` with ``ts`` as epoch seconds (ISO strings are accepted on read).
Replay drives a *virtual clock* from the log timestamps, so windows, baselines
and cooldowns behave exactly as they did live regardless of ``--speed``.
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Awaitable, Callable, Iterator

from .models import ChatMessage

log = logging.getLogger("watch.replay")

Feed = Callable[[ChatMessage], None]
Tick = Callable[[float], Awaitable[None]]


class Recorder:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._fh = path.open("a", encoding="utf-8")
        self.count = 0

    def write(self, msg: ChatMessage) -> None:
        self._fh.write(json.dumps(msg.to_dict(), ensure_ascii=False) + "\n")
        self.count += 1
        if self.count % 50 == 0:
            self._fh.flush()

    def close(self) -> None:
        self._fh.close()
        log.info("recorded %d messages to %s", self.count, self.path)


def read_log(path: Path) -> Iterator[ChatMessage]:
    with path.open("r", encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, 1):
            raw = raw.strip()
            if not raw or raw.startswith("#"):
                continue
            try:
                yield ChatMessage.from_dict(json.loads(raw))
            except (ValueError, KeyError) as exc:
                log.warning("%s:%d skipped: %s", path.name, lineno, exc)


async def replay_log(path: Path, speed: float, feed: Feed, tick: Tick, tail_s: float = 12.0) -> int:
    """Feed the log into ``feed`` while calling ``tick`` once per virtual second.
    ``speed`` 0 means no sleeping at all. Returns the number of messages fed."""
    messages = sorted(read_log(path), key=lambda m: m.ts)
    if not messages:
        log.warning("replay: %s contains no messages", path)
        return 0
    log.info("replay: %d messages spanning %.0fs from %s at %sx",
             len(messages), messages[-1].ts - messages[0].ts, path, "max" if speed <= 0 else speed)

    async def advance(virtual: float, target: float) -> float:
        if speed > 0 and target > virtual:
            await asyncio.sleep((target - virtual) / speed)
        return target

    virtual = messages[0].ts
    next_tick = virtual + 1.0
    for msg in messages:
        while next_tick <= msg.ts:
            virtual = await advance(virtual, next_tick)
            await tick(virtual)
            next_tick += 1.0
        virtual = await advance(virtual, msg.ts)
        feed(msg)
    end = messages[-1].ts + tail_s
    while next_tick <= end:
        virtual = await advance(virtual, next_tick)
        await tick(virtual)
        next_tick += 1.0
    return len(messages)
