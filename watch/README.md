# cutchain `watch/`

A small bot that listens to **Twitch** (anonymously, no token) and **Kick**
(best effort) chat, measures chat velocity and hot words per channel, detects a
"moment" when chat spikes or starts shouting *clip it*, optionally creates a
Twitch clip through the official Helix API, and stores every moment so the
board (`../board`) can show it. Pure asyncio; dependencies are `websockets`,
`aiohttp` and `pyyaml`.

```
Twitch IRC (wss) ─┐                     ┌─ console (1 line/s/channel + banners)
                  ├─► detector ─► moment ├─ data/moments.jsonl + data/watch.db
Kick pusher (wss) ┘   (10 s rate,       ├─ Helix POST /clips  (if TWITCH_TOKEN)
   ▲                   5 min EMA,        └─ GET /api/live, /api/moments, /api/health
   └─ --replay log     hot words,
                       clip pressure)
```

## Run

```bash
cd /home/user/cutchain
pip install -r watch/requirements.txt
cp watch/.env.example watch/.env          # optional: only needed for clip creation

# live: channels from the CLI (overrides config.yaml)
python -m watch --twitch clavicular,xqc --kick adinross --port 8787

# live: channels from watch/config.yaml
python -m watch

# demo: replay the shipped log 10x faster; fires exactly one moment
python -m watch --replay data/demo_chat.log --speed 10

# record a real session, replay it later
python -m watch --twitch kaicenat --record data/chat.log
python -m watch --replay data/chat.log --speed 5
```

Run from the **repository root** (`watch/` is the package itself, so
`python -m watch` needs the parent on `sys.path`). Relative paths on the CLI and
in `config.yaml` (`--record`, `--replay`, `data_dir`) are resolved against the
`watch/` directory, so `data/demo_chat.log` means `watch/data/demo_chat.log`
wherever you run from. Ctrl+C (or SIGTERM) shuts down cleanly: pending moments
are written, the recorder is flushed, the API and SQLite handle are closed.

`python -m watch --help` lists every flag. The useful ones:

| flag | meaning |
| --- | --- |
| `--twitch a,b` / `--kick slug[,slug:chatroom_id]` | channels to watch |
| `--port 8787`, `--host 0.0.0.0` | HTTP API bind |
| `--record path` | append every message as JSON to `path` |
| `--fresh` | wipe `moments.jsonl` and `watch.db` before starting (used by `cutchain replay`) |
| `--replay path --speed N` | replay a log; `--speed 0` = as fast as possible; `--once` exits when done (default keeps the API up) |
| `--min-rate 12 --spike-factor 3 --clip-threshold 5 --cooldown 120 --warmup 30` | detection thresholds |
| `--status-every N` | print the per-channel status line every N seconds |
| `--twitch-irc-url`, `--kick-pusher-url` | override endpoints (used by the test mock) |

Precedence: CLI flag > `config.yaml` > built-in default. `.env` in `watch/` (or
the current directory) is read manually (no python-dotenv); existing environment
variables win.

## How detection works (`detector.py`)

Everything is computed per channel on a one-second tick. Messages are stamped
with local receive time, so the windows share one clock with the ticker (server
timestamps such as `tmi-sent-ts` are ignored on purpose: clock skew would
otherwise push messages "into the future" and out of the window). In replay the
same code runs on a virtual clock derived from the log, so results are
independent of `--speed`.

* **rate** – messages in the last 10 s (`rate_window_s`).
* **baseline** – exponential moving average of `rate` with a 5-minute time
  constant (`baseline_tau_s`). It is *seeded with the first full 10 s
  measurement* after the channel is first seen, so a big channel that is
  steadily doing 100 msgs/10 s does not look like a spike at startup.
* **top words** – tokens of the last 30 s (`hot_window_s`): lowercased,
  punctuation stripped, `@mentions` removed, stopwords / 1–2 char tokens / pure
  numbers dropped, counted once per message. Emote-like tokens (`kekw`,
  `omegalul`, `clueless`) count like any other word — they *are* the signal.
* **clip pressure** – messages in the last 30 s matching
  `\bclip(s|it|ped|per|pers|ping)?\b`, i.e. `clip`, `clip it`, `clipped`,
  `clipper`, `someone clip that`.

A **moment fires** when

```
rate >= max(min_rate, spike_factor * baseline)      # default 12, 3.0
   OR clip_pressure >= clip_threshold                # default 5
```

subject to a per-channel **warm-up** (`warmup_s`, 30 s of history before the
first moment can fire) and a per-channel **cooldown** (`cooldown_s`, 120 s
after a moment). With the defaults, a quiet channel (baseline 4) fires at 12
msgs/10 s, a channel with baseline 30 fires at 90.

Lifecycle of a moment:

1. **Fire** – the tick crosses the threshold. A banner is printed, the row is
   inserted into SQLite (`status=detected|clipping`) and, for Twitch with
   credentials, the Helix clip request goes out *immediately* (Twitch clips
   cover roughly the 90 s before the call, so the earlier the better).
2. **Peak tracking** – for the next 10 s (`peak_track_s`) the detector keeps
   the moment's `rate` and `clip_pressure` at their maximum and refreshes
   `top_words` / `sample_messages`, so the stored record describes the spike
   (e.g. `rate 40 vs base 3.4`) rather than the first tick that crossed the
   line (`rate 13`).
3. **Finalize** – after peak tracking (and after the clip attempt has
   returned) the moment is written once to `data/moments.jsonl` and the SQLite
   row is updated. On shutdown any moment still being tracked is finalized.

Record shape (JSONL, SQLite and the API all use it):

```json
{"id": 1, "ts": "2026-09-05T20:02:02.888Z", "platform": "twitch", "channel": "clavicular",
 "rate": 40, "baseline": 3.39, "clip_pressure": 12,
 "top_words": ["clip", "clipper", "lulw", "kekw", "loool"],
 "sample_messages": ["iamgroot: POGGERS", "noahhhh: L", "mewing_mike: LMAOOO", "zoomerboi: CLIP IT", "mogger_7: moment of the year"],
 "clip_url": null, "status": "detected", "reason": "spike",
 "clip_id": null, "edit_url": null, "error": null}
```

`status` is one of `detected` (no credentials / Kick / replay), `clipping`,
`clipped`, `clip_failed`. `reason` is `spike`, `clip_pressure` or both.

### Thresholds (`config.yaml` → `thresholds:`)

| key | default | notes |
| --- | --- | --- |
| `min_rate` | 12 | msgs/10 s that always count as a spike |
| `spike_factor` | 3.0 | multiple of the baseline |
| `clip_threshold` | 5 | clip requests in 30 s |
| `cooldown_s` | 120 | per channel |
| `warmup_s` | 30 | history needed before the first moment |
| `rate_window_s` / `hot_window_s` | 10 / 30 | window sizes |
| `baseline_tau_s` | 300 | EMA time constant |
| `peak_track_s` | 10 | how long a fired moment keeps refining its stats |

## Clip creation (`clip.py`)

Set `TWITCH_CLIENT_ID` and `TWITCH_TOKEN` in `watch/.env` (see `.env.example`).
The token must be a **user** access token with the `clips:edit` scope; an
`oauth:` prefix is stripped. The broadcaster id is resolved with
`GET https://api.twitch.tv/helix/users?login=<channel>` (cached), then
`POST https://api.twitch.tv/helix/clips?broadcaster_id=<id>`; the response's
`id`/`edit_url` are stored and `clip_url = https://clips.twitch.tv/<id>`.
Without credentials the bot logs `clip skipped (no TWITCH_TOKEN)` and stores the
moment with `status=detected`, `clip_url=null`. Tokens are never logged (only
the first 4 characters of the client id are). Clips are only attempted in live
mode; in replay the moment is stored with an explanatory `error`. Helix
refuses clips for offline channels (404) — that surfaces as `clip_failed` with
the message in the log.

## HTTP API (`api.py`)

aiohttp on `--port` (default 8787), `Access-Control-Allow-Origin: *`, all
timestamps ISO-8601 UTC.

* `GET /api/live` → `{"now", "channels": [{key, platform, channel, rate,
  baseline, clip_pressure, top_words, last_message_ts, msgs_total, threshold,
  warmed_up, cooldown_left_s, moments, updated_ts}]}`
* `GET /api/moments?limit=50` → `{"now", "moments": [record, ...]}` newest
  first (from SQLite, so it includes moments from earlier runs)
* `GET /api/health` → status, uptime, channel/moment counts, mode
  (`live`/`replay`), `clips_enabled`, `kick_status`, active thresholds

## Storage (`store.py`)

`data/moments.jsonl` (append-only, one line per finalized moment) and
`data/watch.db` (SQLite, table `moments`, upserted on every status change).
Moment ids are sequential integers continuing from the highest id in the
database. The in-memory `live` snapshot (`Detector.live`) is the only shared
mutable state; the API reads it directly.

## Record & replay (`replay.py`)

`--record path` appends every message as
`{"ts": <epoch>, "platform", "channel", "user", "text"}`. `--replay path`
feeds the same file through the detector on a virtual clock (`--speed 5` = five
times faster, `0` = no sleeping), ticking once per virtual second and printing
the same status lines and banners as live mode. Moment timestamps are the log's
timestamps. After the replay the API keeps serving until Ctrl+C so a board can
be pointed at it; `--once` exits immediately.

`data/demo_chat.log` is a synthetic but realistic 3-minute log of `#clavicular`
(187 messages, 61 distinct users): ~4 msgs/10 s for two minutes, then at 2:00
the chat explodes to ~40 msgs/10 s with `CLIP IT`, `LMAOOO`, `NAHHH`, `he's
cooked`, `KEKW`, `OMEGALUL`, `Clueless`, tapering off after 2:30. Replaying it
fires exactly one moment (see `tests/replay_run.txt`). Regenerate it with
`python watch/tests/make_demo_log.py`.

## Console output

One line per second per channel:

```
20:02:10 twitch/clavicular rate=40/10s base=4.1 clip=11 top=clip,clipper,lulw (cooldown 112s)
```

and when a moment fires:

```
=======================================================================================
=== MOMENT #1 twitch/clavicular rate 13 vs base 3.4 (clip pressure 2, reason spike) ===
    20:02:02  top: lets, gooo, clip, sheesh, collab
    > ivar: he's cooked
    > dubs_only: clip it clip it
=======================================================================================
=== MOMENT #1 no clip (detected: no TWITCH_TOKEN) ===
=== MOMENT #1 twitch/clavicular saved: peak rate 40/10s vs base 3.4, clip pressure 12, top: clip, clipper, lulw, kekw, loool | clip: none [detected] ===
```

## Twitch details (`twitch.py`)

Connects to `wss://irc-ws.chat.twitch.tv:443`, sends
`NICK justinfan<5 digits>` (anonymous read-only login, no PASS/token),
`CAP REQ :twitch.tv/tags twitch.tv/commands`, then `JOIN #a,#b,...` (batches of
15 with a 10 s pause, under Twitch's 20 JOIN/10 s limit). `PING` is answered
with `PONG`, `RECONNECT` triggers an immediate clean reconnect, any other drop
reconnects with exponential backoff (1 s → 60 s, jittered). Only `PRIVMSG` is
counted; `/me` actions are unwrapped. Anonymous logins can join any channel,
online or not — an offline channel just shows `rate=0`.

## Kick caveats (`kick.py`)

Kick has no official read API; the bot uses what the website uses:

1. `GET https://kick.com/api/v2/channels/<slug>` (then `/api/v1/`) to find
   `chatroom.id`. This endpoint sits behind Cloudflare and frequently answers
   403 to non-browser clients. When it does, pass the id yourself:
   `--kick adinross:123456` or `kick.chatroom_ids: {adinross: 123456}` in
   `config.yaml` (find it in the browser's Network tab on the channel page).
2. `wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=7.6.0&flash=false`,
   `pusher:subscribe` to `chatrooms.<id>.v2`, parse
   `App\Events\ChatMessageEvent` (`data` is a JSON string with `content`,
   `sender.username`, `chatroom_id`). `pusher:ping` is answered with
   `pusher:pong` and a keep-alive ping is sent every 60 s.

Every failure is a `WARNING` and the bot keeps running with Twitch only
(`kick_status` in `/api/health` shows `unavailable`, `connected`,
`reconnecting` or `failed`). The Pusher app key and endpoint are Kick's
current public ones and may change without notice. There is no clip API for
Kick: Kick moments are stored with `status=detected`.

## Tests and verification

```bash
python -m watch.tests.test_watch          # parser + detector checks, no network
bash watch/tests/run_checks.sh            # 45 s live run + replay run -> tests/*_run.txt
MOCK=1 bash watch/tests/run_checks.sh     # same, against tests/mock_irc.py instead of Twitch
```

`tests/mock_irc.py` is a local stand-in for Twitch's IRC gateway (same
handshake, tagged PRIVMSGs at configurable rates, PING every 10 s, one forced
disconnect) for CI and sandboxes without internet access.
`tests/live_run.txt` and `tests/replay_run.txt` hold the captured console
output of both runs; the header of `live_run.txt` records which endpoint that
run used.

## Files

| file | role |
| --- | --- |
| `__main__.py` | CLI, wiring, moment lifecycle, graceful shutdown |
| `config.py` | CLI + `config.yaml` + `.env` merge |
| `twitch.py` | anonymous IRC-over-WebSocket client |
| `kick.py` | Pusher client + chatroom lookup (best effort) |
| `detector.py` | windows, EMA baseline, hot words, clip pressure, spike logic, `live` snapshot |
| `clip.py` | Helix clip creation (`TwitchClipper`) or `NoopClipper` |
| `store.py` | JSONL + SQLite |
| `api.py` | aiohttp endpoints with CORS |
| `replay.py` | recorder and virtual-clock replayer |
| `console.py` | status line and banner formatting |
| `models.py` | `ChatMessage`, `Moment`, ISO helpers |
| `tests/` | offline tests, demo-log generator, mock IRC server, captured runs |
