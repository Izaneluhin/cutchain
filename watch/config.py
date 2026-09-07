"""Settings from CLI flags, ``config.yaml`` and ``.env`` (CLI wins over YAML).

Relative paths (``--record``, ``--replay``, ``data_dir``, ``--config``) are
resolved against the ``watch/`` package directory so that the documented
commands work from the repository root.
"""

from __future__ import annotations

import argparse
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .detector import Thresholds

log = logging.getLogger("watch.config")

PACKAGE_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = PACKAGE_DIR / "config.yaml"
DEFAULT_DATA_DIR = PACKAGE_DIR / "data"


@dataclass(slots=True)
class Settings:
    twitch_channels: list[str] = field(default_factory=list)
    kick_channels: list[str] = field(default_factory=list)
    kick_chatroom_ids: dict[str, int] = field(default_factory=dict)
    thresholds: Thresholds = field(default_factory=Thresholds)
    host: str = "0.0.0.0"
    port: int = 8787
    data_dir: Path = DEFAULT_DATA_DIR
    record: Path | None = None
    replay: Path | None = None
    speed: float = 1.0
    once: bool = False
    fresh: bool = False
    status_every: int = 1
    twitch_irc_url: str | None = None
    kick_pusher_url: str | None = None
    log_level: str = "INFO"
    config_path: Path | None = None


def resolve_path(value: str | os.PathLike[str] | None) -> Path | None:
    if value is None or value == "":
        return None
    path = Path(value).expanduser()
    return path if path.is_absolute() else (PACKAGE_DIR / path).resolve()


def load_dotenv(paths: list[Path] | None = None, environ: os._Environ[str] | dict[str, str] | None = None) -> dict[str, str]:
    """Minimal ``.env`` reader: KEY=VALUE lines, ``#`` comments, optional quotes.
    Existing environment variables are never overridden."""
    env = os.environ if environ is None else environ
    loaded: dict[str, str] = {}
    for path in paths or [PACKAGE_DIR / ".env", Path.cwd() / ".env"]:
        if not path.is_file():
            continue
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            if line.startswith("export "):
                line = line[len("export "):]
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            elif " #" in value:
                value = value.split(" #", 1)[0].rstrip()
            if key and key not in env:
                env[key] = value
                loaded[key] = value
    return loaded


def load_yaml(path: Path | None) -> dict[str, Any]:
    if path is None or not path.is_file():
        return {}
    try:
        import yaml  # type: ignore[import-untyped]
    except ImportError:
        log.warning("PyYAML not installed; ignoring %s (pip install pyyaml)", path)
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: top level must be a mapping")
    return data


def _split_list(value: str | None) -> list[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


def _parse_kick(items: list[str]) -> tuple[list[str], dict[str, int]]:
    """``adinross`` or ``adinross:123456`` (explicit chatroom id)."""
    slugs: list[str] = []
    ids: dict[str, int] = {}
    for item in items:
        slug, _, room = item.partition(":")
        slug = slug.strip().lower()
        if not slug:
            continue
        slugs.append(slug)
        if room.strip().isdigit():
            ids[slug] = int(room)
    return slugs, ids


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m watch", description="cutchain chat moment watcher")
    p.add_argument("--twitch", help="comma-separated Twitch channel logins")
    p.add_argument("--kick", help="comma-separated Kick slugs, optionally slug:chatroom_id")
    p.add_argument("--config", default=str(DEFAULT_CONFIG), help="YAML config (default: watch/config.yaml)")
    p.add_argument("--port", type=int, help="HTTP API port (default 8787)")
    p.add_argument("--host", help="HTTP API bind host (default 0.0.0.0)")
    p.add_argument("--data-dir", help="where moments.jsonl and watch.db live (default watch/data)")
    p.add_argument("--record", help="append every chat message to this JSONL log")
    p.add_argument("--replay", help="replay a recorded log instead of connecting")
    p.add_argument("--speed", type=float, help="replay speed multiplier (0 = as fast as possible)")
    p.add_argument("--fresh", action="store_true", help="clear stored moments before starting (demo runs)")
    p.add_argument("--once", action="store_true", help="exit when the replay finishes instead of keeping the API up")
    p.add_argument("--status-every", type=int, help="print channel status every N seconds (default 1)")
    p.add_argument("--min-rate", type=int)
    p.add_argument("--spike-factor", type=float)
    p.add_argument("--clip-threshold", type=int)
    p.add_argument("--cooldown", type=float, dest="cooldown_s")
    p.add_argument("--warmup", type=float, dest="warmup_s")
    p.add_argument("--twitch-irc-url", help="override IRC websocket URL (testing)")
    p.add_argument("--kick-pusher-url", help="override Kick pusher URL (testing)")
    p.add_argument("--log-level", help="DEBUG, INFO, WARNING")
    return p


def build_settings(argv: list[str] | None = None) -> Settings:
    args = build_parser().parse_args(argv)
    config_path = resolve_path(args.config)
    cfg = load_yaml(config_path)
    twitch_cfg = cfg.get("twitch") or {}
    kick_cfg = cfg.get("kick") or {}
    api_cfg = cfg.get("api") or {}

    thresholds_dict = dict(cfg.get("thresholds") or {})
    for key in ("min_rate", "spike_factor", "clip_threshold", "cooldown_s", "warmup_s"):
        value = getattr(args, key, None)
        if value is not None:
            thresholds_dict[key] = value

    twitch_channels = _split_list(args.twitch) or [str(c) for c in twitch_cfg.get("channels") or []]
    kick_slugs, kick_ids = _parse_kick(_split_list(args.kick) or [str(c) for c in kick_cfg.get("channels") or []])
    kick_ids = {**{str(k).lower(): int(v) for k, v in (kick_cfg.get("chatroom_ids") or {}).items()}, **kick_ids}

    return Settings(
        twitch_channels=[c.lstrip("#").lower() for c in twitch_channels],
        kick_channels=kick_slugs,
        kick_chatroom_ids=kick_ids,
        thresholds=Thresholds.from_dict(thresholds_dict),
        host=args.host or str(api_cfg.get("host", "0.0.0.0")),
        port=args.port or int(api_cfg.get("port", 8787)),
        data_dir=resolve_path(args.data_dir or cfg.get("data_dir")) or DEFAULT_DATA_DIR,
        record=resolve_path(args.record or cfg.get("record")),
        replay=resolve_path(args.replay),
        speed=args.speed if args.speed is not None else float(cfg.get("speed", 1.0)),
        fresh=bool(getattr(args, "fresh", False)),
        once=bool(args.once),
        status_every=max(1, args.status_every or int(cfg.get("status_every", 1))),
        twitch_irc_url=args.twitch_irc_url or twitch_cfg.get("irc_url"),
        kick_pusher_url=args.kick_pusher_url or kick_cfg.get("pusher_url"),
        log_level=(args.log_level or str(cfg.get("log_level", "INFO"))).upper(),
        config_path=config_path if config_path and config_path.is_file() else None,
    )
