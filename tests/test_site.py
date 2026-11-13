import pytest
from aiohttp.test_utils import TestClient, TestServer

from bot.config import Config
from bot.site import build_app, render_policy


def cfg(**kw) -> Config:
    base = dict(bot_token="1:T", admin_ids=frozenset(), brand_name="Chollos Hoy", privacy_url="", persona_name="L",
                persona_photo="", whatsapp_number="", database_url="sqlite+aiosqlite://")
    base.update(kw)
    return Config(**base)


def test_render_fills_legal_fields_and_escapes():
    page = render_policy(cfg(legal_name='UAB "X" <b>', legal_id="123", legal_address="Calle 1", privacy_email="p@x.eu"))
    assert "&lt;b&gt;" in page and "<b>" not in page.split("<h2>1.")[1].split("<h2>2.")[0]
    assert "p@x.eu" in page and "{{" not in page and "pendiente" not in page


def test_missing_email_uses_bot_contact_without_placeholders():
    page = render_policy(cfg(legal_name="N", legal_id="1", legal_address="A"))
    assert "pendiente" not in page and "{{" not in page and "<mark>" not in page
    assert "a través de este bot de Telegram" in page


async def test_routes():
    app = build_app(cfg(legal_name="N", legal_id="1", legal_address="A", privacy_email="e@x.eu"))
    async with TestClient(TestServer(app)) as c:
        r = await c.get("/privacidad")
        assert r.status == 200 and "text/html" in r.headers["Content-Type"]
        assert "Política de privacidad" in await r.text()
        r = await c.get("/", allow_redirects=False)
        assert r.status == 302 and r.headers["Location"] == "/privacidad"
        assert (await c.get("/healthz")).status == 200
