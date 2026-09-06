"""Generate data/demo_chat.log: 3 minutes of synthetic Twitch chat for
#clavicular with a ~4 msgs/10 s baseline and one big spike at 2:00.

Run from the repo root:  python watch/tests/make_demo_log.py
"""

from __future__ import annotations

import json
import random
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data" / "demo_chat.log"
START_TS = 1788638400.0  # 2026-09-05T20:00:00Z
CHANNEL = "clavicular"

USERS = [
    "mogger_7", "bonesmash", "tyler_r", "chad_enjoyer", "notjaylen", "ml_flex", "pinkyy",
    "zaydn", "kevin_lifts", "sub2dylan", "bruh_moment99", "lilcrumb", "jawline_andy",
    "xX_dan_Xx", "yung_sigma", "cactusjackk", "poggerino", "eli_mogs", "ratio_king",
    "ssaltyy", "hunterr", "ogslayer", "notsurewhy", "cheekbones", "mewing_mike", "gigachadd",
    "ashton_v", "noahhhh", "trentt", "qwerty_lo", "carter_w", "silentboi", "bigmac_fan",
    "veeeezy", "wakeupsheep", "goldenboy21", "jordan_m", "d3ni5", "iamgroot", "mrbeast_fan_",
    "n0thing", "sussybaka", "kkona_farmer", "luvvsadie", "phil_the_thrill", "rockyy",
    "spookyhalo", "tokyodrift", "usernametaken", "vibes_only", "winterrr", "xanderr",
    "yeetus", "zoomerboi", "aaronn", "baconator", "cloutchaser", "dubs_only", "emotecheck",
    "frontrow", "getmogged", "hairline_hank", "ivar", "jimothy", "kekwer", "lurker_lou",
]

CALM = [
    "what game is this", "W stream", "lol", "he's actually decent at this", "KEKW",
    "first time here, seems chill", "how long has he been live", "bro is locked in",
    "Clueless", "lmao", "when is the collab", "that was clean", "OMEGALUL",
    "any1 else lagging", "he said that yesterday too", "gg", "true", "this song is fire",
    "nah he's right tho", "sheesh", "monkaS", "Sadge", "LULW", "hi chat", "he needs water",
    "what happened to the last stream", "PogU", "why is he so quiet today",
    "can he do the tier list again", "who is he talking to", "wait what", "ok that's fair",
    "PepeLaugh", "bro forgot to unmute", "yo", "lets gooo", "he's cooking", "real",
    "how many hours today", "hydrate streamer", "xdd", "L take honestly", "lmfao",
    "the mods are asleep", "COPIUM", "is this a rerun", "hello from germany",
    "brooo the audio", "he cooked that guy earlier", "Aware", "lol why", "bruh",
    "that's actually cap", "damn ok", "raid when", "he is so him", "same energy",
    "@mogger_7 fr", "@tyler_r lol no", "someone tell him", "clip that later", "Bedge",
    "goofy ahh stream", "this is peak", "ICANT", "nah", "cringe but funny", "EZ",
]

SPIKE = [
    "CLIP IT", "CLIP IT", "CLIP IT", "CLIP THAT", "clip it clip it", "SOMEONE CLIP THAT",
    "CLIPPER WHERE U AT", "clip clip clip", "CLIPPED", "clip that NOW", "LMAOOO", "LMAOOOOO",
    "LMFAOOO", "W", "W", "W", "WWWWW", "NAHHH", "NAHHHHH", "NAH BRO", "he's cooked",
    "HE'S COOKED", "HES SO COOKED", "COOKED", "KEKW", "KEKW", "KEKW", "OMEGALUL", "OMEGALUL",
    "OMEGALUL", "Clueless", "Clueless", "NOOOO", "WHAT", "WHAT WAS THAT", "BRO", "BROOOO",
    "NO WAY", "NO WAYYY", "ICANT", "ICANT", "HE FELL OFF", "IT'S OVER", "THE FIGHT LMAO",
    "he really did that", "WHAT IS HE DOING", "PepeLaugh", "POGGERS", "PogU", "HOLY",
    "GG", "L", "LLLLL", "ratio", "he's done", "BYE", "IM DEAD", "im crying lmao",
    "THIS IS WHY I SUB", "peak stream", "xdd", "LULW", "AINT NO WAY", "someone clip pls",
    "CLIP THIS", "moment of the year", "HELP", "not him doing that", "NAH THATS CRAZY",
    "the fight!!!", "he got cooked", "OH NO", "wait WHAT", "LOOOL", "🤣🤣🤣", "💀💀💀",
]

TAPER = [
    "lmao that was insane", "still laughing", "KEKW", "someone post the clip",
    "was that real", "he's so cooked lol", "W moment", "did anyone clip it", "OMEGALUL",
    "chat calm down", "ok that was funny", "he's recovering lol", "bro is embarrassed",
    "xdd", "unreal", "nah that goes in the highlights", "he needs a minute", "Clueless",
    "gg", "peak", "what just happened lol", "lmfao", "ICANT", "mods pin that",
]


def phase_messages(rng: random.Random, t0: float, t1: float, gap: tuple[float, float], pool: list[str]) -> list[tuple[float, str, str]]:
    msgs = []
    t = t0 + rng.uniform(*gap)
    while t < t1:
        msgs.append((round(t, 3), rng.choice(USERS), rng.choice(pool)))
        t += rng.uniform(*gap)
    return msgs


def main() -> None:
    rng = random.Random(20260906)
    msgs: list[tuple[float, str, str]] = []
    # 0:00-2:00 calm: 2.0-3.0 s gaps -> 3-5 msgs / 10 s
    msgs += phase_messages(rng, START_TS, START_TS + 120, (2.0, 3.0), CALM)
    # 2:00-2:30 spike: 0.2-0.3 s gaps -> ~40 msgs / 10 s
    msgs += phase_messages(rng, START_TS + 120, START_TS + 150, (0.2, 0.3), SPIKE)
    # 2:30-3:00 taper: 1.2-2.0 s gaps -> ~6 msgs / 10 s
    msgs += phase_messages(rng, START_TS + 150, START_TS + 180, (1.2, 2.0), TAPER)
    msgs.sort()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8") as fh:
        for ts, user, text in msgs:
            fh.write(json.dumps({"ts": ts, "platform": "twitch", "channel": CHANNEL, "user": user, "text": text}, ensure_ascii=False) + "\n")
    print(f"wrote {len(msgs)} messages to {OUT}")


if __name__ == "__main__":
    main()
