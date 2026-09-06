"""Moment persistence: append-only JSONL plus a SQLite table for queries."""

from __future__ import annotations

import json
import logging
import sqlite3
from pathlib import Path
from typing import Any

from .models import Moment

log = logging.getLogger("watch.store")

SCHEMA = """
CREATE TABLE IF NOT EXISTS moments (
    id              INTEGER PRIMARY KEY,
    ts              REAL    NOT NULL,
    ts_iso          TEXT    NOT NULL,
    platform        TEXT    NOT NULL,
    channel         TEXT    NOT NULL,
    rate            INTEGER NOT NULL,
    baseline        REAL    NOT NULL,
    clip_pressure   INTEGER NOT NULL,
    top_words       TEXT    NOT NULL,
    sample_messages TEXT    NOT NULL,
    clip_url        TEXT,
    status          TEXT    NOT NULL,
    reason          TEXT,
    clip_id         TEXT,
    edit_url        TEXT,
    error           TEXT
);
CREATE INDEX IF NOT EXISTS moments_ts ON moments(ts DESC);
"""


class MomentStore:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.jsonl_path = data_dir / "moments.jsonl"
        self.db_path = data_dir / "watch.db"
        self._db = sqlite3.connect(self.db_path)
        self._db.row_factory = sqlite3.Row
        self._db.executescript(SCHEMA)
        self._db.commit()
        row = self._db.execute("SELECT COALESCE(MAX(id), 0) FROM moments").fetchone()
        self._last_id = int(row[0])

    def next_id(self) -> int:
        self._last_id += 1
        return self._last_id

    def upsert(self, moment: Moment) -> None:
        d = moment.to_dict()
        self._db.execute(
            """INSERT INTO moments (id, ts, ts_iso, platform, channel, rate, baseline, clip_pressure,
                   top_words, sample_messages, clip_url, status, reason, clip_id, edit_url, error)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                   clip_url=excluded.clip_url, status=excluded.status, clip_id=excluded.clip_id,
                   edit_url=excluded.edit_url, error=excluded.error, rate=excluded.rate,
                   baseline=excluded.baseline, clip_pressure=excluded.clip_pressure,
                   top_words=excluded.top_words, sample_messages=excluded.sample_messages""",
            (
                d["id"], moment.ts, d["ts"], d["platform"], d["channel"], d["rate"], d["baseline"],
                d["clip_pressure"], json.dumps(d["top_words"]), json.dumps(d["sample_messages"]),
                d["clip_url"], d["status"], d["reason"], d["clip_id"], d["edit_url"], d["error"],
            ),
        )
        self._db.commit()

    def append_jsonl(self, moment: Moment) -> None:
        with self.jsonl_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(moment.to_dict(), ensure_ascii=False) + "\n")

    def save(self, moment: Moment) -> None:
        """Final write for a moment: one JSONL line plus the SQLite upsert."""
        self.upsert(moment)
        self.append_jsonl(moment)

    def latest(self, limit: int = 50) -> list[dict[str, Any]]:
        rows = self._db.execute(
            "SELECT * FROM moments ORDER BY ts DESC, id DESC LIMIT ?", (max(1, min(limit, 1000)),)
        ).fetchall()
        return [_row_to_dict(r) for r in rows]

    def count(self) -> int:
        return int(self._db.execute("SELECT COUNT(*) FROM moments").fetchone()[0])

    def close(self) -> None:
        self._db.close()


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "ts": row["ts_iso"],
        "platform": row["platform"],
        "channel": row["channel"],
        "rate": row["rate"],
        "baseline": row["baseline"],
        "clip_pressure": row["clip_pressure"],
        "top_words": json.loads(row["top_words"]),
        "sample_messages": json.loads(row["sample_messages"]),
        "clip_url": row["clip_url"],
        "status": row["status"],
        "reason": row["reason"],
        "clip_id": row["clip_id"],
        "edit_url": row["edit_url"],
        "error": row["error"],
    }
