"""Реальный HTTP: локальный сервер ведёт себя как веб-приложение Apps Script (ответ через 302)."""
import json

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from bot import sheets
from bot.config import Config


def cfg(url: str) -> Config:
    return Config(bot_token="1:T", admin_ids=frozenset(), brand_name="B", privacy_url="", persona_name="L",
                  persona_photo="", whatsapp_number="", database_url="sqlite+aiosqlite://", sheets_webhook_url=url)


async def run_server(replies: list[dict], seen: list[dict]):
    async def exec_post(request):
        seen.append(json.loads(await request.text()))
        raise web.HTTPFound("/echo")

    async def echo(request):
        return web.json_response(replies.pop(0))

    app = web.Application()
    app.router.add_post("/exec", exec_post)
    app.router.add_get("/echo", echo)
    server = TestServer(app)
    await server.start_server()
    return server


async def test_flat_payload_ok_and_duplicate_count_as_success(monkeypatch):
    seen: list[dict] = []
    server = await run_server([{"ok": True}, {"ok": True, "duplicate": True}], seen)
    c = cfg(str(server.make_url("/exec")))
    row = {"lead_id": "tg_1", "phone": "+34612345678", "whatsapp_consent": True}
    assert await sheets.post_lead(c, row) == {"ok": True}
    assert (await sheets.post_lead(c, row))["duplicate"] is True
    assert seen[0] == row  # ушёл плоский объект без обёрток
    await server.close()


async def test_busy_is_retried_but_logic_errors_are_not(monkeypatch):
    async def no_sleep(_): pass
    monkeypatch.setattr(sheets.asyncio, "sleep", no_sleep)
    seen: list[dict] = []
    server = await run_server([{"ok": False, "error": "busy"}, {"ok": True}], seen)
    c = cfg(str(server.make_url("/exec")))
    assert (await sheets.post_lead(c, {"lead_id": "tg_1"})) == {"ok": True}
    assert len(seen) == 2
    await server.close()

    seen2: list[dict] = []
    server = await run_server([{"ok": False, "error": "missing_columns", "columns": ["x"]}], seen2)
    c = cfg(str(server.make_url("/exec")))
    assert await sheets.post_lead(c, {"lead_id": "tg_1"}) is None
    assert len(seen2) == 1  # повтора нет
    await server.close()


async def test_unreachable_returns_none(monkeypatch):
    async def no_sleep(_): pass
    monkeypatch.setattr(sheets.asyncio, "sleep", no_sleep)
    assert await sheets.post_lead(cfg("http://127.0.0.1:9/exec"), {"lead_id": "tg_1"}, attempts=2) is None
