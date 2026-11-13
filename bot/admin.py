from __future__ import annotations

import asyncio
import csv
import datetime as dt
import io
import logging
from zoneinfo import ZoneInfo

from aiogram import Bot, F, Router
from aiogram.exceptions import TelegramAPIError, TelegramForbiddenError, TelegramRetryAfter
from aiogram.filters import Command, CommandObject
from aiogram.types import BufferedInputFile, Message

from . import sheets
from .config import Config
from .db import Database

log = logging.getLogger(__name__)

MADRID = ZoneInfo("Europe/Madrid")

router = Router(name="admin")
router.message.filter(F.chat.type == "private")

# admin_id -> текст рассылки, ждущий /confirm
_pending: dict[int, str] = {}

FOOTER = "\n\nPara dejar de recibir ofertas: /stop"


def _is_admin(message: Message, cfg: Config) -> bool:
    return message.from_user is not None and message.from_user.id in cfg.admin_ids


def _pct(part: int, whole: int) -> str:
    return f"{part / whole * 100:.0f}%" if whole else "0%"


def _source_lines(rows: list[tuple[str, int, int]]) -> list[str]:
    return [f"{src}: {started} / {phones} ({_pct(phones, started)})" for src, started, phones in rows]


@router.message(Command("stats"))
async def stats(message: Message, db: Database, cfg: Config) -> None:
    if not _is_admin(message, cfg):
        return
    s = await db.stats()
    now = dt.datetime.now(MADRID)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    today = await db.window(today_start)
    week = await db.window(today_start - dt.timedelta(days=6))  # сегодня и 6 предыдущих дней
    lines = [
        "📊 <b>Estadísticas</b>",
        f"Han pulsado /start: <b>{s.total_started}</b>",
        f"Compartieron número: <b>{s.with_phone}</b> ({_pct(s.with_phone, s.total_started)})",
        f"Activos (sin baja): <b>{s.active}</b>",
        f"Bajas: {s.opted_out}",
        "",
        "<b>Por periodo (start → número):</b>",
        f"Hoy: {today.started} → {today.phones} ({_pct(today.phones, today.started)})",
        f"7 días: {week.started} → {week.phones} ({_pct(week.phones, week.started)})",
    ]
    if s.by_region:
        lines.append("\n<b>Por país (activos):</b>")
        lines += [f"{region}: {n}" for region, n in s.by_region]
    if s.by_source:
        lines.append("\n<b>Por source, total (start / número, conversión):</b>")
        lines += _source_lines([(a, b, c) for a, b, c in s.by_source])
    if week.by_source:
        lines.append("\n<b>Por source, últimos 7 días:</b>")
        lines += _source_lines(week.by_source)
    lines.append("\nHora de Madrid. Se cuenta por fecha del primer /start.")
    await message.answer("\n".join(lines))


@router.message(Command("export"))
async def export(message: Message, db: Database, cfg: Config) -> None:
    if not _is_admin(message, cfg):
        return
    rows = await db.export_rows()
    buf = io.StringIO()
    buf.write("﻿")  # BOM, чтобы Excel открыл UTF-8 без кракозябр
    w = csv.writer(buf)
    w.writerow(
        ["phone", "region", "valid", "first_name", "username", "language", "source", "consent_at_utc", "consent_version", "telegram_id"]
    )
    for r in rows:
        w.writerow(
            [
                r.phone_e164,
                r.phone_region or "",
                int(bool(r.phone_valid)),
                r.first_name or "",
                r.username or "",
                r.language_code or "",
                r.source or "",
                r.consent_at.isoformat() if r.consent_at else "",
                r.consent_version or "",
                r.telegram_id,
            ]
        )
    data = buf.getvalue().encode("utf-8")
    await message.answer_document(
        BufferedInputFile(data, filename="leads.csv"),
        caption=f"{len(rows)} números con consentimiento y sin baja",
    )


@router.message(Command("resync"))
async def resync(message: Message, db: Database, cfg: Config) -> None:
    if not _is_admin(message, cfg):
        return
    if not cfg.sheets_webhook_url:
        await message.answer("SHEETS_WEBHOOK_URL no está configurado.")
        return
    ok, failed = await sheets.resync_all(db, cfg)
    await message.answer(f"Enviados a Google Sheets: {ok}. Fallidos: {failed}.")


@router.message(Command("broadcast"))
async def broadcast_prepare(message: Message, command: CommandObject, db: Database, cfg: Config) -> None:
    if not _is_admin(message, cfg):
        return
    text = (command.args or "").strip()
    if not text:
        await message.answer("Uso: /broadcast texto del mensaje (admite HTML). Después /confirm.")
        return
    targets = await db.broadcast_targets()
    _pending[message.from_user.id] = text
    await message.answer(f"Se enviará a <b>{len(targets)}</b> personas (con número y sin baja). Para enviar: /confirm. Para cancelar: /cancel.")


@router.message(Command("cancel"))
async def broadcast_cancel(message: Message, cfg: Config) -> None:
    if not _is_admin(message, cfg):
        return
    _pending.pop(message.from_user.id, None)
    await message.answer("Cancelado.")


@router.message(Command("confirm"))
async def broadcast_send(message: Message, bot: Bot, db: Database, cfg: Config) -> None:
    if not _is_admin(message, cfg):
        return
    text = _pending.pop(message.from_user.id, None)
    if text is None:
        await message.answer("No hay ninguna difusión pendiente.")
        return
    targets = await db.broadcast_targets()
    await message.answer(f"Enviando a {len(targets)}…")
    sent = blocked = failed = 0
    for uid in targets:
        try:
            try:
                await bot.send_message(uid, text + FOOTER, disable_web_page_preview=True)
            except TelegramRetryAfter as e:
                await asyncio.sleep(e.retry_after)
                await bot.send_message(uid, text + FOOTER, disable_web_page_preview=True)
            sent += 1
        except TelegramForbiddenError:
            blocked += 1
        except TelegramAPIError:
            failed += 1
            log.exception("broadcast failed uid=%s", uid)
        await asyncio.sleep(0.05)  # ~20 сообщений в секунду, лимит Telegram 30/с
    await message.answer(f"Listo. Enviados: {sent}, bloquearon el bot: {blocked}, ошибок: {failed}")
