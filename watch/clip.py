"""Twitch clip creation through the official Helix API.

Needs ``TWITCH_CLIENT_ID`` and ``TWITCH_TOKEN`` (a *user* access token with the
``clips:edit`` scope). Tokens are never logged.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Mapping, Protocol

import aiohttp

log = logging.getLogger("watch.clip")

HELIX = "https://api.twitch.tv/helix"
CLIP_URL = "https://clips.twitch.tv/{id}"


@dataclass(frozen=True, slots=True)
class ClipResult:
    id: str
    edit_url: str
    clip_url: str


class Clipper(Protocol):
    enabled: bool

    async def create_clip(self, login: str) -> ClipResult | None: ...

    async def close(self) -> None: ...


class NoopClipper:
    """Used when credentials are absent: moments stay ``detected``."""

    enabled = False

    async def create_clip(self, login: str) -> ClipResult | None:
        log.info("clip skipped (no TWITCH_TOKEN) for twitch/%s", login)
        return None

    async def close(self) -> None:
        return None


class TwitchClipper:
    enabled = True

    def __init__(self, client_id: str, token: str) -> None:
        self._client_id = client_id
        self._token = token.removeprefix("oauth:").strip()
        self._ids: dict[str, str] = {}
        self._session: aiohttp.ClientSession | None = None

    def _headers(self) -> dict[str, str]:
        return {"Client-Id": self._client_id, "Authorization": f"Bearer {self._token}"}

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                trust_env=True, timeout=aiohttp.ClientTimeout(total=20), headers=self._headers()
            )
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def broadcaster_id(self, login: str) -> str | None:
        login = login.lower()
        if login in self._ids:
            return self._ids[login]
        session = await self._get_session()
        try:
            async with session.get(f"{HELIX}/users", params={"login": login}) as resp:
                body = await resp.json(content_type=None)
                if resp.status != 200:
                    log.warning("helix users lookup failed for %s: HTTP %s %s", login, resp.status, _msg(body))
                    return None
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            log.warning("helix users lookup failed for %s: %s", login, exc)
            return None
        data = body.get("data") or []
        if not data:
            log.warning("helix: no user named %s", login)
            return None
        self._ids[login] = str(data[0]["id"])
        return self._ids[login]

    async def create_clip(self, login: str) -> ClipResult | None:
        broadcaster = await self.broadcaster_id(login)
        if broadcaster is None:
            return None
        session = await self._get_session()
        try:
            async with session.post(f"{HELIX}/clips", params={"broadcaster_id": broadcaster}) as resp:
                body = await resp.json(content_type=None)
                if resp.status not in (200, 202):
                    log.warning("clip failed for %s: HTTP %s %s", login, resp.status, _msg(body))
                    return None
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            log.warning("clip failed for %s: %s", login, exc)
            return None
        data = body.get("data") or []
        if not data:
            log.warning("clip failed for %s: empty response", login)
            return None
        clip_id = str(data[0]["id"])
        result = ClipResult(id=clip_id, edit_url=str(data[0].get("edit_url", "")), clip_url=CLIP_URL.format(id=clip_id))
        log.info("clip created for %s: %s", login, result.clip_url)
        return result


def _msg(body: object) -> str:
    if isinstance(body, dict):
        return str(body.get("message") or body.get("error") or "")
    return ""


def clipper_from_env(env: Mapping[str, str]) -> Clipper:
    client_id = (env.get("TWITCH_CLIENT_ID") or "").strip()
    token = (env.get("TWITCH_TOKEN") or "").strip()
    if client_id and token:
        log.info("twitch clip creation enabled (client id %s...)", client_id[:4])
        return TwitchClipper(client_id, token)
    log.info("twitch clip creation disabled: TWITCH_CLIENT_ID/TWITCH_TOKEN not set")
    return NoopClipper()
