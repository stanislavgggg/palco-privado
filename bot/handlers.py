from __future__ import annotations

import logging
import re
from pathlib import Path

from aiogram import F, Router
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.types import (
    FSInputFile,
    KeyboardButton,
    Message,
    ReplyKeyboardMarkup,
    ReplyKeyboardRemove,
)

from . import sheets, texts
from .config import CONSENT_VERSION, Config
from .db import Database
from .offers import format_coupon, format_deals, get_welcome_coupon, load_offers
from .phone import parse_phone

log = logging.getLogger(__name__)

router = Router(name="user")
router.message.filter(F.chat.type == "private")

_SOURCE_RE = re.compile(r"[^A-Za-z0-9_\-]")


def clean_source(arg: str | None) -> str | None:
    if not arg:
        return None
    s = _SOURCE_RE.sub("", arg)[:64]
    return s or None


def contact_kb() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[[KeyboardButton(text=texts.BTN_SHARE, request_contact=True)]],
        resize_keyboard=True,
        one_time_keyboard=True,
    )


def menu_kb() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[[KeyboardButton(text=texts.BTN_DEALS)], [KeyboardButton(text=texts.BTN_STOP)]],
        resize_keyboard=True,
    )


async def _touch(message: Message, db: Database, source: str | None = None) -> None:
    u = message.from_user
    await db.touch_user(u.id, u.username, u.first_name, u.language_code, source)


@router.message(CommandStart())
async def on_start(message: Message, command: CommandObject, db: Database, cfg: Config) -> None:
    await _touch(message, db, clean_source(command.args))
    text = texts.welcome(cfg.persona_name, cfg.brand_name, cfg.privacy_url, message.from_user.first_name)
    photo = Path(cfg.persona_photo) if cfg.persona_photo else None
    has_photo = photo is not None and photo.is_file()
    if has_photo and len(text) <= 1024:
        await message.answer_photo(FSInputFile(photo), caption=text, reply_markup=contact_kb())
    elif has_photo:
        await message.answer_photo(FSInputFile(photo))
        await message.answer(text, reply_markup=contact_kb(), disable_web_page_preview=True)
    else:
        await message.answer(text, reply_markup=contact_kb(), disable_web_page_preview=True)


@router.message(F.contact)
async def on_contact(message: Message, db: Database, cfg: Config) -> None:
    await _touch(message, db)
    contact = message.contact

    # Telegram позволяет переслать чужую карточку контакта: принимаем только собственный номер
    if contact.user_id != message.from_user.id:
        await message.answer(texts.foreign_contact(), reply_markup=contact_kb())
        return

    parsed = parse_phone(contact.phone_number)
    if parsed is None:
        await message.answer(texts.bad_phone(), reply_markup=contact_kb())
        return

    if cfg.allowed_regions and parsed.region not in cfg.allowed_regions:
        await message.answer(texts.region_not_allowed(), reply_markup=ReplyKeyboardRemove())
        return

    await db.save_phone(message.from_user.id, parsed.e164, parsed.region, parsed.valid, CONSENT_VERSION)
    log.info("phone saved user=%s region=%s valid=%s", message.from_user.id, parsed.region, parsed.valid)
    sheets.schedule_sync(db, cfg, message.from_user.id)

    coupon = get_welcome_coupon(cfg)
    await message.answer(
        texts.success(message.from_user.first_name, format_coupon(coupon) if coupon else "", cfg.whatsapp_number),
        reply_markup=menu_kb(),
    )


@router.message(F.text == texts.BTN_DEALS)
async def on_deals(message: Message, db: Database) -> None:
    await _touch(message, db)
    deals = [d for d in load_offers().get("deals", []) if d.get("title")]
    if not deals:
        await message.answer(texts.no_deals())
        return
    await message.answer(format_deals(deals), disable_web_page_preview=True)


@router.message(Command("stop"))
@router.message(F.text == texts.BTN_STOP)
async def on_stop(message: Message, db: Database) -> None:
    await db.opt_out(message.from_user.id)
    await message.answer(texts.stopped(), reply_markup=ReplyKeyboardRemove())


@router.message(Command("privacidad"))
async def on_privacy(message: Message, cfg: Config) -> None:
    await message.answer(texts.privacy(cfg.privacy_url), disable_web_page_preview=True)


@router.message(Command("borrar"))
async def on_erase(message: Message, db: Database) -> None:
    await db.erase(message.from_user.id)
    await message.answer(texts.erased(), reply_markup=ReplyKeyboardRemove())


@router.message(F.text)
async def on_other_text(message: Message, db: Database) -> None:
    await _touch(message, db)
    await message.answer(texts.reask_contact(), reply_markup=contact_kb())
