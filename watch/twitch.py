"""Anonymous Twitch IRC-over-WebSocket chat reader.

No token needed: Twitch accepts ``NICK justinfanNNNNN`` for read-only access.
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable

import websockets
from websockets.exceptions import WebSocketException

from .models import ChatMessage

log = logging.getLogger("watch.twitch")

TWITCH_IRC_URL = "wss://irc-ws.chat.twitch.tv:443"
JOIN_BATCH = 15  # Twitch allows 20 JOINs / 10 s for unverified clients
MessageHandler = Callable[[ChatMessage], Awaitable[None] | None]


@dataclass(slots=True)
class IrcLine:
    command: str
    params: list[str] = field(default_factory=list)
    prefix: str = ""
    tags: dict[str, str] = field(default_factory=dict)

    @property
    def nick(self) -> str:
        return self.prefix.split("!", 1)[0] if self.prefix else ""


def _unescape_tag(value: str) -> str:
    return (
        value.replace("\\s", " ")
        .replace("\\:", ";")
        .replace("\\r", "\r")
        .replace("\\n", "\n")
        .replace("\\\\", "\\")
    )


def parse_irc_line(line: str) -> IrcLine | None:
    """Parse ``@tags :prefix COMMAND params :trailing`` into an IrcLine."""
    line = line.rstrip("\r\n")
    if not line:
        return None
    tags: dict[str, str] = {}
    if line.startswith("@"):
        raw_tags, _, line = line[1:].partition(" ")
        for item in raw_tags.split(";"):
            k, _, v = item.partition("=")
            tags[k] = _unescape_tag(v)
    prefix = ""
    if line.startswith(":"):
        prefix, _, line = line[1:].partition(" ")
    head, sep, trailing = line.partition(" :")
    params = head.split()
    if not params:
        return None
    command = params.pop(0)
    if sep:
        params.append(trailing)
    return IrcLine(command=command, params=params, prefix=prefix, tags=tags)


def privmsg_to_chat(irc: IrcLine, now: float | None = None) -> ChatMessage | None:
    """Messages are stamped with *local receive time* (not ``tmi-sent-ts``) so
    the sliding windows share one clock with the ticker regardless of skew."""
    if irc.command != "PRIVMSG" or len(irc.params) < 2:
        return None
    channel = irc.params[0].lstrip("#").lower()
    text = irc.params[-1]
    user = irc.tags.get("display-name") or irc.nick or "?"
    return ChatMessage(platform="twitch", channel=channel, user=user, text=text, ts=now or time.time())


def anonymous_nick() -> str:
    return f"justinfan{random.randint(10000, 99999)}"


class TwitchChat:
    """Reads chat for a set of channels and reconnects forever with backoff."""

    def __init__(
        self,
        channels: list[str],
        on_message: MessageHandler,
        url: str = TWITCH_IRC_URL,
        max_backoff_s: float = 60.0,
    ) -> None:
        self.channels = [c.lstrip("#").lower() for c in channels if c.strip()]
        self.on_message = on_message
        self.url = url
        self.max_backoff_s = max_backoff_s
        self.connected = False
        self.messages_seen = 0

    async def run(self) -> None:
        if not self.channels:
            log.info("no twitch channels configured")
            return
        backoff = 1.0
        while True:
            try:
                await self._session()
                backoff = 1.0  # clean RECONNECT request: retry immediately
            except asyncio.CancelledError:
                raise
            except (OSError, asyncio.TimeoutError, WebSocketException) as exc:
                log.warning("twitch: connection error: %s: %s", type(exc).__name__, exc)
            except Exception as exc:  # noqa: BLE001 - keep the bot alive
                log.exception("twitch: unexpected error: %s", exc)
            finally:
                self.connected = False
            delay = backoff + random.uniform(0, backoff / 2)
            log.info("twitch: reconnecting in %.1fs", delay)
            await asyncio.sleep(delay)
            backoff = min(backoff * 2, self.max_backoff_s)

    async def _session(self) -> None:
        log.info("twitch: connecting to %s for %s", self.url, ", ".join(self.channels))
        async with websockets.connect(self.url, open_timeout=20, ping_interval=None, max_size=2**20) as ws:
            await self._handshake(ws)
            self.connected = True
            async for frame in ws:
                if isinstance(frame, bytes):
                    frame = frame.decode("utf-8", "replace")
                for line in frame.split("\r\n"):
                    if line and await self._handle_line(ws, line):
                        return  # server asked us to reconnect

    async def _handshake(self, ws: websockets.ClientConnection) -> None:
        await ws.send(f"NICK {anonymous_nick()}")
        await ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands")
        for i in range(0, len(self.channels), JOIN_BATCH):
            batch = self.channels[i : i + JOIN_BATCH]
            await ws.send("JOIN " + ",".join(f"#{c}" for c in batch))
            if i + JOIN_BATCH < len(self.channels):
                await asyncio.sleep(10)
        log.info("twitch: joined %d channel(s) anonymously", len(self.channels))

    async def _handle_line(self, ws: websockets.ClientConnection, line: str) -> bool:
        """Returns True when the connection should be re-established."""
        irc = parse_irc_line(line)
        if irc is None:
            return False
        if irc.command == "PING":
            await ws.send("PONG :" + (irc.params[-1] if irc.params else "tmi.twitch.tv"))
            return False
        if irc.command == "PRIVMSG":
            msg = privmsg_to_chat(irc)
            if msg is not None:
                self.messages_seen += 1
                result = self.on_message(msg)
                if asyncio.iscoroutine(result):
                    await result
            return False
        if irc.command == "RECONNECT":
            log.info("twitch: server requested RECONNECT")
            return True
        if irc.command == "NOTICE":
            log.warning("twitch: NOTICE %s", irc.params[-1] if irc.params else "")
        elif irc.command == "JOIN":
            log.debug("twitch: joined %s", irc.params[0] if irc.params else "?")
        return False
