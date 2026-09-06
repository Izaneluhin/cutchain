"""Best-effort Kick chat reader over Kick's public Pusher WebSocket.

Kick has no official read API. The chatroom id normally comes from
``https://kick.com/api/v2/channels/{slug}`` which is frequently fronted by a
Cloudflare challenge; when that fails the id can be given in config. Any
failure here is logged and swallowed so the bot keeps running on Twitch.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from typing import Any, Awaitable, Callable

import aiohttp
import websockets
from websockets.exceptions import WebSocketException

from .models import ChatMessage

log = logging.getLogger("watch.kick")

KICK_PUSHER_URL = (
    "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679"
    "?protocol=7&client=js&version=7.6.0&flash=false"
)
KICK_CHANNEL_APIS = (
    "https://kick.com/api/v2/channels/{slug}",
    "https://kick.com/api/v1/channels/{slug}",
)
BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
}
CHAT_EVENT = "App\\Events\\ChatMessageEvent"
MessageHandler = Callable[[ChatMessage], Awaitable[None] | None]


async def resolve_chatroom_id(session: aiohttp.ClientSession, slug: str) -> int | None:
    """Look up the chatroom id for a channel slug; None if Kick blocks us."""
    for template in KICK_CHANNEL_APIS:
        url = template.format(slug=slug)
        try:
            async with session.get(url, headers=BROWSER_HEADERS, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                if resp.status != 200:
                    log.warning("kick: %s returned HTTP %s (Cloudflare?)", url, resp.status)
                    continue
                data = await resp.json(content_type=None)
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as exc:
            log.warning("kick: lookup %s failed: %s", url, exc)
            continue
        chatroom = data.get("chatroom") if isinstance(data, dict) else None
        if isinstance(chatroom, dict) and isinstance(chatroom.get("id"), int):
            return int(chatroom["id"])
        log.warning("kick: no chatroom id in response from %s", url)
    return None


def parse_chat_event(payload: dict[str, Any], room_to_slug: dict[int, str], now: float | None = None) -> ChatMessage | None:
    """Turn a Pusher frame into a ChatMessage, or None for non-chat events."""
    if payload.get("event") != CHAT_EVENT:
        return None
    data = payload.get("data")
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except ValueError:
            return None
    if not isinstance(data, dict):
        return None
    room_id = data.get("chatroom_id")
    channel = room_to_slug.get(int(room_id)) if isinstance(room_id, int) else None
    if channel is None:  # fall back to the pusher channel name
        pusher_channel = str(payload.get("channel", ""))
        digits = "".join(ch for ch in pusher_channel if ch.isdigit())
        channel = room_to_slug.get(int(digits)) if digits else None
    if channel is None:
        channel = f"chatroom-{room_id}"
    sender = data.get("sender") or {}
    user = str(sender.get("username") or sender.get("slug") or "?")
    text = str(data.get("content") or "")
    # Local receive time, like Twitch: one clock for windows and ticker.
    return ChatMessage(platform="kick", channel=channel, user=user, text=text, ts=now or time.time())


class KickChat:
    def __init__(
        self,
        slugs: list[str],
        on_message: MessageHandler,
        chatroom_ids: dict[str, int] | None = None,
        url: str = KICK_PUSHER_URL,
        max_backoff_s: float = 60.0,
    ) -> None:
        self.slugs = [s.strip().lower() for s in slugs if s.strip()]
        self.on_message = on_message
        self.chatroom_ids = {k.lower(): int(v) for k, v in (chatroom_ids or {}).items()}
        self.url = url
        self.max_backoff_s = max_backoff_s
        self.room_to_slug: dict[int, str] = {}
        self.connected = False
        self.messages_seen = 0
        self.status = "disabled"

    async def run(self) -> None:
        """Never raises (except cancellation): Kick is strictly optional."""
        if not self.slugs:
            return
        try:
            await self._resolve_rooms()
            if not self.room_to_slug:
                self.status = "unavailable"
                log.warning("kick: no chatroom ids resolved; running with Twitch only "
                            "(set kick.chatroom_ids in config.yaml or use --kick slug:id)")
                return
            await self._loop()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            self.status = "failed"
            log.warning("kick: disabled after unexpected error: %s: %s", type(exc).__name__, exc)

    async def _resolve_rooms(self) -> None:
        pending = [s for s in self.slugs if s not in self.chatroom_ids]
        if pending:
            async with aiohttp.ClientSession(trust_env=True) as session:
                for slug in pending:
                    room = await resolve_chatroom_id(session, slug)
                    if room is None:
                        log.warning("kick: could not resolve chatroom id for %r; skipping", slug)
                    else:
                        self.chatroom_ids[slug] = room
        for slug in self.slugs:
            room = self.chatroom_ids.get(slug)
            if room is not None:
                self.room_to_slug[room] = slug
                log.info("kick: %s -> chatroom %d", slug, room)

    async def _loop(self) -> None:
        backoff = 1.0
        while True:
            try:
                await self._session()
            except asyncio.CancelledError:
                raise
            except (OSError, asyncio.TimeoutError, WebSocketException) as exc:
                self.status = "reconnecting"
                log.warning("kick: connection error: %s: %s", type(exc).__name__, exc)
            finally:
                self.connected = False
            delay = backoff + random.uniform(0, backoff / 2)
            log.info("kick: reconnecting in %.1fs", delay)
            await asyncio.sleep(delay)
            backoff = min(backoff * 2, self.max_backoff_s)

    async def _session(self) -> None:
        log.info("kick: connecting to pusher for chatrooms %s", sorted(self.room_to_slug))
        async with websockets.connect(self.url, open_timeout=20, ping_interval=None) as ws:
            for room in self.room_to_slug:
                await ws.send(json.dumps({"event": "pusher:subscribe",
                                          "data": {"auth": "", "channel": f"chatrooms.{room}.v2"}}))
            self.connected = True
            self.status = "connected"
            keepalive = asyncio.create_task(self._keepalive(ws))
            try:
                async for frame in ws:
                    await self._handle_frame(ws, frame)
            finally:
                keepalive.cancel()

    async def _keepalive(self, ws: websockets.ClientConnection) -> None:
        while True:
            await asyncio.sleep(60)
            await ws.send(json.dumps({"event": "pusher:ping", "data": {}}))

    async def _handle_frame(self, ws: websockets.ClientConnection, frame: str | bytes) -> None:
        if isinstance(frame, bytes):
            frame = frame.decode("utf-8", "replace")
        try:
            payload = json.loads(frame)
        except ValueError:
            return
        event = payload.get("event")
        if event == "pusher:ping":
            await ws.send(json.dumps({"event": "pusher:pong", "data": {}}))
        elif event == "pusher:connection_established":
            log.info("kick: pusher connection established")
        elif event == "pusher:error":
            log.warning("kick: pusher error: %s", payload.get("data"))
        elif event == CHAT_EVENT:
            msg = parse_chat_event(payload, self.room_to_slug)
            if msg is not None:
                self.messages_seen += 1
                result = self.on_message(msg)
                if asyncio.iscoroutine(result):
                    await result
