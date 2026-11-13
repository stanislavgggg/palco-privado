"""Отправка лидов в Google Sheets через уже существующее веб-приложение Apps Script (то же, что принимает лиды с квиз-лендингов).

Контракт скрипта: POST одного плоского JSON-объекта, ключи = названия колонок листа; обязательны lead_id,
phone (от 7 цифр) и whatsapp_consent = true. Дубли скрипт определяет по lead_id и отвечает {"ok": true, "duplicate": true}.
Ответ при ошибке: {"ok": false, "error": "..."}; "busy" означает, что скрипт занят другим запросом, можно повторить.
"""
from __future__ import annotations

import asyncio
import json
import logging

import aiohttp

from .config import Config
from .db import Database

log = logging.getLogger(__name__)

QUIZ_ID = "es_tg_chollos_bot"
_tasks: set[asyncio.Task] = set()  # держим ссылки, иначе фоновые задачи могут быть собраны GC


def lead_row(u, cfg: Config) -> dict:
    """u: строка из таблицы users. Ключи совпадают с колонками листа Untitled."""
    answers = {
        "channel": "telegram_bot",
        "source": u.source,
        "telegram_id": u.telegram_id,
        "username": u.username,
        "first_name": u.first_name,
        "phone_valid": bool(u.phone_valid),
    }
    return {
        "lead_id": f"tg_{u.telegram_id}",
        "quiz_id": QUIZ_ID,
        "geo": u.phone_region or "",
        "phone": u.phone_e164,
        "whatsapp_consent": True,
        "consent": False,  # в схеме таблицы это согласие на email-рассылку: email мы не собираем
        "answers_json": json.dumps(answers, ensure_ascii=False),
        "consent_text_version": u.consent_version or "",
        "utm_source": "telegram",
        "utm_campaign": u.source or "",
        "brand": cfg.brand_name,
        "referrer": "telegram_bot",
    }


async def post_lead(cfg: Config, row: dict, attempts: int = 3) -> dict | None:
    """Возвращает ответ скрипта при ok=true (включая duplicate), иначе None."""
    if not cfg.sheets_webhook_url:
        return None
    timeout = aiohttp.ClientTimeout(total=30)
    for attempt in range(1, attempts + 1):
        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:
                # Apps Script отвечает редиректом 302, aiohttp сам его проходит: запись к этому моменту уже выполнена
                async with session.post(cfg.sheets_webhook_url, data=json.dumps(row), allow_redirects=True) as resp:
                    text = await resp.text()
            data = json.loads(text)
            if data.get("ok"):
                return data
            if data.get("error") == "busy" and attempt < attempts:
                await asyncio.sleep(2 * attempt)
                continue
            log.error("sheets webhook отказал: %s", data)
            return None  # ошибка логики (нет колонок, нет согласия): повторять бессмысленно
        except (aiohttp.ClientError, asyncio.TimeoutError, json.JSONDecodeError):
            log.warning("sheets webhook: попытка %s/%s не удалась", attempt, attempts, exc_info=attempt == attempts)
            if attempt < attempts:
                await asyncio.sleep(2 * attempt)
    return None


async def sync_user(db: Database, cfg: Config, telegram_id: int) -> None:
    u = await db.get_user(telegram_id)
    if u is None or not u.phone_e164:
        return
    res = await post_lead(cfg, lead_row(u, cfg))
    if res is not None:
        await db.mark_synced([telegram_id])
        log.info("lead synced user=%s duplicate=%s", telegram_id, bool(res.get("duplicate")))
    else:
        log.error("lead NOT synced user=%s (останется в базе, отправится командой /resync)", telegram_id)


def schedule_sync(db: Database, cfg: Config, telegram_id: int) -> None:
    """Фоновая отправка: человек не ждёт ответа Google."""
    if not cfg.sheets_webhook_url:
        return
    task = asyncio.create_task(sync_user(db, cfg, telegram_id))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def resync_all(db: Database, cfg: Config) -> tuple[int, int]:
    """Отправляет всё, что ещё не ушло, по одному (скрипт держит блокировку). Возвращает (отправлено, не удалось)."""
    ok = failed = 0
    for u in await db.unsynced():
        res = await post_lead(cfg, lead_row(u, cfg))
        if res is None:
            failed += 1
        else:
            await db.mark_synced([u.telegram_id])
            ok += 1
        await asyncio.sleep(0.3)
    return ok, failed
