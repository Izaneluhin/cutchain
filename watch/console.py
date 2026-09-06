"""Compact console formatting for status lines and moment banners."""

from __future__ import annotations

import time

from .detector import LiveStats
from .models import Moment


def clock(ts: float) -> str:
    return time.strftime("%H:%M:%S", time.localtime(ts))


def fmt_status(stats: LiveStats, now: float, window_s: float = 10.0) -> str:
    top = ",".join(stats.top_words[:3]) or "-"
    flags = ""
    if not stats.warmed_up:
        flags = " (warming up)"
    elif stats.cooldown_left_s > 0:
        flags = f" (cooldown {stats.cooldown_left_s:.0f}s)"
    return (
        f"{clock(now)} {stats.key} rate={stats.rate}/{window_s:.0f}s "
        f"base={stats.baseline:.1f} clip={stats.clip_pressure} top={top}{flags}"
    )


def fmt_moment(moment: Moment) -> str:
    head = (
        f"=== MOMENT #{moment.id} {moment.key} rate {moment.rate} vs base {moment.baseline:.1f} "
        f"(clip pressure {moment.clip_pressure}, reason {moment.reason}) ==="
    )
    bar = "=" * len(head)
    lines = [bar, head]
    lines.append(f"    {clock(moment.ts)}  top: {', '.join(moment.top_words) or '-'}")
    for sample in moment.sample_messages[:5]:
        lines.append(f"    > {sample[:120]}")
    lines.append(bar)
    return "\n".join(lines)


def fmt_clip_result(moment: Moment) -> str:
    if moment.clip_url:
        return f"=== MOMENT #{moment.id} clip: {moment.clip_url} ({moment.status}) ==="
    detail = moment.error or ("no TWITCH_TOKEN" if moment.status == "detected" else "")
    return f"=== MOMENT #{moment.id} no clip ({moment.status}{': ' + detail if detail else ''}) ==="


def fmt_final(moment: Moment) -> str:
    clip = moment.clip_url or "none"
    return (
        f"=== MOMENT #{moment.id} {moment.key} saved: peak rate {moment.rate}/10s vs base "
        f"{moment.baseline:.1f}, clip pressure {moment.clip_pressure}, top: "
        f"{', '.join(moment.top_words) or '-'} | clip: {clip} [{moment.status}] ==="
    )
