"""Shared data types: chat messages and detected moments."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


def iso(ts: float | None) -> str | None:
    """Epoch seconds -> ISO-8601 UTC string with millisecond precision."""
    if ts is None:
        return None
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_iso(value: str) -> float:
    """ISO-8601 string (with Z or offset) -> epoch seconds."""
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


@dataclass(slots=True)
class ChatMessage:
    platform: str  # "twitch" | "kick"
    channel: str  # lowercase channel login / kick slug, without '#'
    user: str
    text: str
    ts: float  # epoch seconds

    @property
    def key(self) -> str:
        return f"{self.platform}/{self.channel}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "ts": self.ts,
            "platform": self.platform,
            "channel": self.channel,
            "user": self.user,
            "text": self.text,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ChatMessage":
        ts = data["ts"]
        if isinstance(ts, str):
            ts = parse_iso(ts)
        return cls(
            platform=str(data.get("platform", "twitch")),
            channel=str(data["channel"]).lstrip("#").lower(),
            user=str(data.get("user", "")),
            text=str(data.get("text", "")),
            ts=float(ts),
        )


@dataclass(slots=True)
class Moment:
    id: int
    ts: float
    platform: str
    channel: str
    rate: int
    baseline: float
    clip_pressure: int
    top_words: list[str] = field(default_factory=list)
    sample_messages: list[str] = field(default_factory=list)
    clip_url: str | None = None
    status: str = "detected"  # detected | clipping | clipped | clip_failed
    reason: str = "spike"  # spike | clip_pressure | spike+clip_pressure
    clip_id: str | None = None
    edit_url: str | None = None
    error: str | None = None

    @property
    def key(self) -> str:
        return f"{self.platform}/{self.channel}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "ts": iso(self.ts),
            "platform": self.platform,
            "channel": self.channel,
            "rate": self.rate,
            "baseline": round(self.baseline, 2),
            "clip_pressure": self.clip_pressure,
            "top_words": self.top_words[:5],
            "sample_messages": self.sample_messages[:5],
            "clip_url": self.clip_url,
            "status": self.status,
            "reason": self.reason,
            "clip_id": self.clip_id,
            "edit_url": self.edit_url,
            "error": self.error,
        }
