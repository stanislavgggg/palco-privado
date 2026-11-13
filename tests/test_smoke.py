"""Прогон бота на фейковых апдейтах: без сети и без настоящего токена."""
from __future__ import annotations

import datetime as dt
from pathlib import Path

import pytest
from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.base import BaseSession
from aiogram.enums import ParseMode
from aiogram.methods import TelegramMethod
from aiogram.types import Chat, Contact, Message, MessageEntity, Update, User

from bot import admin, handlers
from bot.config import Config
from bot.db import Database
from bot.phone import parse_phone

ADMIN = 999
USER = 42


def new_dispatcher(db, cfg, *, with_admin=True) -> Dispatcher:
    """Роутеры в боте модульные (в проде один Dispatcher), поэтому в тестах отцепляем их от прошлого."""
    dp = Dispatcher()
    dp["db"] = db
    dp["cfg"] = cfg
    routers = ([admin.router] if with_admin else []) + [handlers.router]
    for r in routers:
        r._parent_router = None
        dp.include_router(r)
    return dp


class FakeSession(BaseSession):
    def __init__(self):
        super().__init__()
        self.calls: list[TelegramMethod] = []

    async def close(self):  # pragma: no cover
        pass

    async def stream_content(self, *a, **kw):  # pragma: no cover
        yield b""

    async def make_request(self, bot, method, timeout=None):
        self.calls.append(method)
        name = type(method).__name__
        if name.startswith("Send"):
            return Message(
                message_id=len(self.calls),
                date=dt.datetime.now(dt.timezone.utc),
                chat=Chat(id=getattr(method, "chat_id", 1), type="private"),
            )
        return True

    def texts(self) -> list[str]:
        return [getattr(c, "text", None) or getattr(c, "caption", None) or "" for c in self.calls]


def make_cfg(tmp_path, **kw) -> Config:
    base = dict(
        bot_token="123456:TEST",
        admin_ids=frozenset({ADMIN}),
        brand_name="Chollos Hoy",
        privacy_url="https://example.com/privacy",
        persona_name="Lucía",
        persona_photo=str(tmp_path / "nope.jpg"),
        whatsapp_number="",
        database_url=f"sqlite+aiosqlite:///{tmp_path}/t.db",
        allowed_regions=frozenset(),
        welcome_coupon_code="TESTCODE",
    )
    base.update(kw)
    return Config(**base)


@pytest.fixture
async def env(tmp_path):
    cfg = make_cfg(tmp_path)
    db = Database(cfg.database_url)
    await db.init()
    session = FakeSession()
    bot = Bot("123456:TEST", session=session, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dp = new_dispatcher(db, cfg)
    yield dp, bot, session, db, cfg
    await db.close()


_uid = 0


def msg(user_id: int, text: str | None = None, contact: Contact | None = None) -> Update:
    global _uid
    _uid += 1
    entities = None
    if text and text.startswith("/"):
        entities = [MessageEntity(type="bot_command", offset=0, length=len(text.split()[0]))]
    m = Message(
        message_id=_uid,
        date=dt.datetime.now(dt.timezone.utc),
        chat=Chat(id=user_id, type="private"),
        from_user=User(id=user_id, is_bot=False, first_name="Marta", username="marta", language_code="es"),
        text=text,
        entities=entities,
        contact=contact,
    )
    return Update(update_id=_uid, message=m)


def test_phone_parse():
    p = parse_phone("34612345678")
    assert p.e164 == "+34612345678" and p.region == "ES" and p.valid
    assert parse_phone("12") is None
    assert parse_phone("abc") is None


async def test_start_stores_source_once_and_shows_consent(env):
    dp, bot, session, db, cfg = env
    await dp.feed_update(bot, msg(USER, "/start es_tgads_chollos1"))
    await dp.feed_update(bot, msg(USER, "/start otra_fuente"))
    out = session.texts()[0]
    assert "Soy Lucía" in out and "aceptas recibir" in out and "/stop" in out and "example.com/privacy" in out
    s = await db.stats()
    assert s.total_started == 1 and s.with_phone == 0
    assert s.by_source[0][0] == "es_tgads_chollos1"  # вторая ссылка source не перезаписала


async def test_share_own_contact_saves_and_sends_coupon(env):
    dp, bot, session, db, cfg = env
    await dp.feed_update(bot, msg(USER, "/start src1"))
    await dp.feed_update(bot, msg(USER, contact=Contact(phone_number="34612345678", first_name="Marta", user_id=USER)))
    last = session.texts()[-1]
    assert "Ya estás dentro" in last and "<code>TESTCODE</code>" in last
    rows = await db.export_rows()
    assert len(rows) == 1 and rows[0].phone_e164 == "+34612345678" and rows[0].phone_region == "ES"
    assert rows[0].consent_version and rows[0].consent_at is not None


async def test_foreign_contact_rejected(env):
    dp, bot, session, db, cfg = env
    await dp.feed_update(bot, msg(USER, "/start"))
    await dp.feed_update(bot, msg(USER, contact=Contact(phone_number="34699999999", first_name="Otro", user_id=777)))
    assert "no es el tuyo" in session.texts()[-1]
    assert await db.export_rows() == []


async def test_region_filter(tmp_path):
    cfg = make_cfg(tmp_path, allowed_regions=frozenset({"ES"}))
    db = Database(cfg.database_url)
    await db.init()
    session = FakeSession()
    bot = Bot("123456:TEST", session=session)
    dp = new_dispatcher(db, cfg, with_admin=False)
    await dp.feed_update(bot, msg(USER, "/start"))
    await dp.feed_update(bot, msg(USER, contact=Contact(phone_number="5215512345678", first_name="M", user_id=USER)))
    assert await db.export_rows() == []
    await db.close()


async def test_stop_then_reshare_and_erase(env):
    dp, bot, session, db, cfg = env
    await dp.feed_update(bot, msg(USER, "/start"))
    await dp.feed_update(bot, msg(USER, contact=Contact(phone_number="34612345678", first_name="M", user_id=USER)))
    await dp.feed_update(bot, msg(USER, "/stop"))
    assert await db.export_rows() == [] and await db.broadcast_targets() == []
    # повторное согласие снимает отписку
    await dp.feed_update(bot, msg(USER, contact=Contact(phone_number="34612345678", first_name="M", user_id=USER)))
    assert len(await db.export_rows()) == 1
    await dp.feed_update(bot, msg(USER, "/borrar"))
    s = await db.stats()
    assert s.total_started == 0


async def test_admin_stats_export_broadcast(env):
    dp, bot, session, db, cfg = env
    await dp.feed_update(bot, msg(USER, "/start srcA"))
    await dp.feed_update(bot, msg(USER, contact=Contact(phone_number="34612345678", first_name="M", user_id=USER)))

    # не админ: тишина
    n = len(session.calls)
    await dp.feed_update(bot, msg(USER, "/stats"))
    assert len(session.calls) == n

    await dp.feed_update(bot, msg(ADMIN, "/stats"))
    out = session.texts()[-1]
    assert "Compartieron número: <b>1</b>" in out and "srcA" in out
    assert "Hoy: 1 → 1 (100%)" in out and "7 días: 1 → 1 (100%)" in out and "srcA: 1 / 1 (100%)" in out

    await dp.feed_update(bot, msg(ADMIN, "/export"))
    doc = session.calls[-1]
    content = doc.document.data.decode("utf-8-sig")
    assert "+34612345678" in content and "srcA" in content

    await dp.feed_update(bot, msg(ADMIN, "/broadcast Oferta de prueba"))
    assert "<b>1</b>" in session.texts()[-1]
    await dp.feed_update(bot, msg(ADMIN, "/confirm"))
    sent = [c for c in session.calls if type(c).__name__ == "SendMessage" and c.chat_id == USER and "Oferta de prueba" in (c.text or "")]
    assert len(sent) == 1 and "/stop" in sent[0].text


async def test_photo_welcome_when_file_exists(tmp_path):
    photo = tmp_path / "p.jpg"
    photo.write_bytes(b"\xff\xd8\xff\xd9")
    cfg = make_cfg(tmp_path, persona_photo=str(photo))
    db = Database(cfg.database_url)
    await db.init()
    session = FakeSession()
    bot = Bot("123456:TEST", session=session)
    dp = new_dispatcher(db, cfg, with_admin=False)
    await dp.feed_update(bot, msg(USER, "/start"))
    assert type(session.calls[0]).__name__ == "SendPhoto"
    await db.close()


# ---------- Google Sheets ----------
import asyncio  # noqa: E402

from bot import sheets  # noqa: E402


async def test_lead_goes_to_sheet_in_quiz_schema_and_is_marked_synced(tmp_path, monkeypatch):
    cfg = make_cfg(tmp_path, sheets_webhook_url="https://script.google.com/macros/s/X/exec")
    db = Database(cfg.database_url)
    await db.init()
    session = FakeSession()
    bot = Bot("123456:TEST", session=session)
    dp = new_dispatcher(db, cfg)

    sent: list[dict] = []

    async def fake_post(cfg_, row, attempts=3):
        sent.append(row)
        return {"ok": True}

    monkeypatch.setattr(sheets, "post_lead", fake_post)

    await dp.feed_update(bot, msg(USER, "/start es_tgads_chollos1"))
    await dp.feed_update(bot, msg(USER, contact=Contact(phone_number="34612345678", first_name="Marta", user_id=USER)))
    await asyncio.sleep(0.1)  # фоновая задача

    assert len(sent) == 1
    row = sent[0]
    assert row["phone"] == "+34612345678" and row["geo"] == "ES" and row["lead_id"] == f"tg_{USER}"
    assert row["quiz_id"] == "es_tg_chollos_bot" and row["whatsapp_consent"] is True and row["consent"] is False
    assert row["utm_source"] == "telegram" and row["utm_campaign"] == "es_tgads_chollos1"
    assert row["consent_text_version"] and "rows" not in row and "secret" not in row
    assert await db.unsynced() == []  # помечен как отправленный
    await db.close()


async def test_failed_sync_stays_pending_and_resync_delivers(tmp_path, monkeypatch):
    cfg = make_cfg(tmp_path, sheets_webhook_url="https://script.google.com/macros/s/X/exec")
    db = Database(cfg.database_url)
    await db.init()
    session = FakeSession()
    bot = Bot("123456:TEST", session=session)
    dp = new_dispatcher(db, cfg)

    async def down(cfg_, row, attempts=3):
        return None

    monkeypatch.setattr(sheets, "post_lead", down)
    await dp.feed_update(bot, msg(USER, "/start"))
    await dp.feed_update(bot, msg(USER, contact=Contact(phone_number="34612345678", first_name="M", user_id=USER)))
    await asyncio.sleep(0.1)
    assert len(await db.unsynced()) == 1

    delivered: list[dict] = []

    async def up(cfg_, row, attempts=3):
        delivered.append(row)
        return {"ok": True}

    monkeypatch.setattr(sheets, "post_lead", up)
    await dp.feed_update(bot, msg(ADMIN, "/resync"))
    assert len(delivered) == 1 and await db.unsynced() == []
    assert "Enviados a Google Sheets: 1" in session.texts()[-1]
    await db.close()


async def test_migration_adds_sheet_synced_at_to_old_table(tmp_path):
    import sqlalchemy as sa

    url = f"sqlite+aiosqlite:///{tmp_path}/old.db"
    from sqlalchemy.ext.asyncio import create_async_engine

    eng = create_async_engine(url)
    async with eng.begin() as conn:  # «старая» схема без sheet_synced_at
        await conn.execute(sa.text(
            "CREATE TABLE users (telegram_id BIGINT PRIMARY KEY, username VARCHAR(64), first_name VARCHAR(128), "
            "language_code VARCHAR(16), source VARCHAR(128), started_at DATETIME NOT NULL, last_seen_at DATETIME NOT NULL, "
            "phone_e164 VARCHAR(20), phone_region VARCHAR(4), phone_valid BOOLEAN, consent_at DATETIME, "
            "consent_version VARCHAR(32), opted_out_at DATETIME)"
        ))
    await eng.dispose()
    db = Database(url)
    await db.init()
    await db.touch_user(1, "u", "n", "es", "src")
    assert await db.unsynced() == []  # без номера не считается
    await db.close()


async def test_privacy_command(env):
    dp, bot, session, db, cfg = env
    await dp.feed_update(bot, msg(USER, "/privacidad"))
    assert "example.com/privacy" in session.texts()[-1]


async def test_no_coupon_configured_sends_no_fake_code(tmp_path):
    cfg = make_cfg(tmp_path, welcome_coupon_code="")
    db = Database(cfg.database_url)
    await db.init()
    session = FakeSession()
    bot = Bot("123456:TEST", session=session)
    dp = new_dispatcher(db, cfg, with_admin=False)
    await dp.feed_update(bot, msg(USER, "/start"))
    await dp.feed_update(bot, msg(USER, contact=Contact(phone_number="34612345678", first_name="M", user_id=USER)))
    out = session.texts()[-1]
    assert "Ya estás dentro" in out and "Código:" not in out and "EDITA" not in out
    await db.close()


async def test_coupon_from_env_vars(tmp_path):
    cfg = make_cfg(tmp_path, welcome_coupon_code="CHOLLO10", welcome_coupon_title="10% de regalo",
                   welcome_coupon_description="Válido hasta el 30/11")
    db = Database(cfg.database_url)
    await db.init()
    session = FakeSession()
    bot = Bot("123456:TEST", session=session)
    dp = new_dispatcher(db, cfg, with_admin=False)
    await dp.feed_update(bot, msg(USER, "/start"))
    await dp.feed_update(bot, msg(USER, contact=Contact(phone_number="34612345678", first_name="M", user_id=USER)))
    out = session.texts()[-1]
    assert "<code>CHOLLO10</code>" in out and "10% de regalo" in out and "Válido hasta el 30/11" in out
    await db.close()
