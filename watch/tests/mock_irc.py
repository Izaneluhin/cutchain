"""Local stand-in for wss://irc-ws.chat.twitch.tv used to exercise the live
Twitch path when the real host is unreachable (firewalled CI, sandboxes).

It speaks the same dialogue as Twitch's IRC gateway: expects NICK / CAP REQ /
JOIN, answers with the 001..376 welcome, CAP ACK, JOIN echo and ROOMSTATE,
emits tagged PRIVMSG lines at a configurable rate per channel, sends
``PING :tmi.twitch.tv`` every 10 s, and (optionally) drops the connection once
so the client's reconnect/backoff path runs.

    python watch/tests/mock_irc.py --port 6667 --rates kaicenat=30,xqc=20 --drop-after 20
    python -m watch --twitch kaicenat,xqc --twitch-irc-url ws://127.0.0.1:6667
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import random
import time

from websockets.asyncio.server import ServerConnection, serve

log = logging.getLogger("mock_irc")

USERS = ["mogger_7", "bonesmash", "tyler_r", "pinkyy", "zaydn", "kevin_lifts", "lilcrumb",
         "xX_dan_Xx", "poggerino", "ratio_king", "ssaltyy", "hunterr", "cheekbones", "gigachadd",
         "noahhhh", "carter_w", "silentboi", "veeeezy", "jordan_m", "sussybaka", "luvvsadie",
         "rockyy", "tokyodrift", "vibes_only", "xanderr", "zoomerboi", "cloutchaser", "frontrow"]
LINES = ["KEKW", "OMEGALUL", "W", "L", "lmao", "Clueless", "what game is this", "he's cooked",
         "LULW", "PogU", "monkaS", "nah bro", "true", "gg", "hi chat", "xdd", "ICANT", "real",
         "lets gooo", "sheesh", "bro is locked in", "any1 else lagging", "clip that", "Sadge",
         "PepeLaugh", "this is peak", "COPIUM", "he said what", "W stream", "LMAOOO"]


def privmsg(channel: str) -> str:
    user = random.choice(USERS)
    ts = int(time.time() * 1000)
    tags = (f"@badge-info=;badges=;color=#1E90FF;display-name={user};emotes=;first-msg=0;"
            f"flags=;id={random.randint(10**9, 10**10)};mod=0;returning-chatter=0;room-id=1;"
            f"subscriber=0;tmi-sent-ts={ts};turbo=0;user-id={random.randint(1, 10**6)};user-type=")
    return f"{tags} :{user.lower()}!{user.lower()}@{user.lower()}.tmi.twitch.tv PRIVMSG #{channel} :{random.choice(LINES)}"


class MockTwitchIrc:
    def __init__(self, rates: dict[str, float], drop_after: float | None) -> None:
        self.rates = rates  # channel -> messages per 10 s
        self.drop_after = drop_after
        self.dropped_once = False
        self.pongs = 0

    async def handle(self, ws: ServerConnection) -> None:
        nick, joined = "", []
        start = time.time()
        async def reader() -> None:
            nonlocal nick
            async for raw in ws:
                line = raw.decode() if isinstance(raw, bytes) else raw
                cmd, _, rest = line.partition(" ")
                if cmd == "NICK":
                    nick = rest.strip()
                    await ws.send(f":tmi.twitch.tv 001 {nick} :Welcome, GLHF!\r\n:tmi.twitch.tv 376 {nick} :>")
                    log.info("client logged in as %s", nick)
                elif cmd == "CAP":
                    await ws.send(":tmi.twitch.tv CAP * ACK :twitch.tv/tags twitch.tv/commands")
                elif cmd == "JOIN":
                    for ch in rest.strip().split(","):
                        ch = ch.lstrip("#")
                        joined.append(ch)
                        await ws.send(f":{nick}!{nick}@{nick}.tmi.twitch.tv JOIN #{ch}\r\n"
                                      f"@emote-only=0;followers-only=-1;r9k=0;room-id=1;slow=0;subs-only=0 "
                                      f":tmi.twitch.tv ROOMSTATE #{ch}")
                    log.info("client joined %s", joined)
                elif cmd == "PONG":
                    self.pongs += 1
                    log.info("got PONG (%d so far)", self.pongs)

        async def pinger() -> None:
            while True:
                await asyncio.sleep(10)
                await ws.send("PING :tmi.twitch.tv")
                log.info("sent PING")

        async def chatter() -> None:
            while True:
                if not joined:
                    await asyncio.sleep(0.2)
                    continue
                if self.drop_after and not self.dropped_once and time.time() - start > self.drop_after:
                    self.dropped_once = True
                    log.info("dropping connection to exercise reconnect")
                    await ws.close(code=1012, reason="mock restart")
                    return
                batch = []
                for ch in joined:
                    per_sec = self.rates.get(ch, 5.0) / 10.0
                    n = sum(1 for _ in range(int(per_sec) + 1) if random.random() < per_sec / (int(per_sec) + 1))
                    batch += [privmsg(ch) for _ in range(n)]
                random.shuffle(batch)
                for i in range(0, len(batch), 3):  # several lines per frame, like Twitch
                    await ws.send("\r\n".join(batch[i:i + 3]) + "\r\n")
                await asyncio.sleep(1.0)

        tasks = [asyncio.create_task(reader()), asyncio.create_task(pinger()), asyncio.create_task(chatter())]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for t in tasks:
                t.cancel()
            log.info("connection closed")


def parse_rates(text: str) -> dict[str, float]:
    out: dict[str, float] = {}
    for item in text.split(","):
        name, _, rate = item.partition("=")
        if name.strip():
            out[name.strip().lower()] = float(rate or 5)
    return out


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=6667)
    ap.add_argument("--rates", default="kaicenat=30,xqc=20,jynxzi=12,caseoh_=6")
    ap.add_argument("--drop-after", type=float, default=None, help="close the first connection after N s")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s MOCK %(message)s", datefmt="%H:%M:%S")
    server = MockTwitchIrc(parse_rates(args.rates), args.drop_after)
    async with serve(server.handle, "127.0.0.1", args.port):
        log.info("mock twitch irc on ws://127.0.0.1:%d rates=%s", args.port, server.rates)
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
