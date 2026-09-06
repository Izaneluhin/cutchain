"""Tiny aiohttp API the board reads from. CORS is wide open (``*``)."""

from __future__ import annotations

import logging
import time
from typing import Any, Awaitable, Callable

from aiohttp import web

from .detector import Detector
from .models import iso
from .store import MomentStore

log = logging.getLogger("watch.api")

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
}
Handler = Callable[[web.Request], Awaitable[web.StreamResponse]]


@web.middleware
async def cors_middleware(request: web.Request, handler: Handler) -> web.StreamResponse:
    if request.method == "OPTIONS":
        return web.Response(status=204, headers=CORS_HEADERS)
    response = await handler(request)
    response.headers.update(CORS_HEADERS)
    return response


InfoFn = Callable[[], dict[str, Any]]


def build_app(detector: Detector, store: MomentStore, info: InfoFn | None = None) -> web.Application:
    app = web.Application(middlewares=[cors_middleware])
    app["detector"] = detector
    app["store"] = store
    app["info"] = info or (lambda: {})
    app["started_at"] = time.time()
    app.router.add_get("/api/live", live)
    app.router.add_get("/api/moments", moments)
    app.router.add_get("/api/health", health)
    app.router.add_get("/", index)
    return app


async def index(request: web.Request) -> web.Response:
    return web.json_response({"service": "cutchain-watch", "endpoints": ["/api/live", "/api/moments?limit=50", "/api/health"]})


async def live(request: web.Request) -> web.Response:
    detector: Detector = request.app["detector"]
    channels = [stats.to_dict() for stats in detector.live.values()]
    channels.sort(key=lambda c: (c["platform"], c["channel"]))
    return web.json_response({"now": iso(time.time()), "channels": channels})


async def moments(request: web.Request) -> web.Response:
    store: MomentStore = request.app["store"]
    try:
        limit = int(request.query.get("limit", "50"))
    except ValueError:
        raise web.HTTPBadRequest(text="limit must be an integer")
    return web.json_response({"now": iso(time.time()), "moments": store.latest(limit)})


async def health(request: web.Request) -> web.Response:
    detector: Detector = request.app["detector"]
    store: MomentStore = request.app["store"]
    body = {
        "status": "ok",
        "now": iso(time.time()),
        "uptime_s": round(time.time() - request.app["started_at"], 1),
        "channels": len(detector.live),
        "moments": store.count(),
        **request.app["info"](),
    }
    return web.json_response(body)


async def start_api(app: web.Application, host: str, port: int) -> web.AppRunner:
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, host, port)
    await site.start()
    log.info("api listening on http://%s:%d (GET /api/live, /api/moments, /api/health)", host, port)
    return runner
