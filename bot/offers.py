from __future__ import annotations

import html
import json
import logging
from pathlib import Path

from .config import Config

log = logging.getLogger(__name__)

OFFERS_PATH = Path(__file__).resolve().parent.parent / "offers.json"
PLACEHOLDER_CODE = "EDITA-ESTE-CODIGO"


def load_offers() -> dict:
    """Читаем при каждом запросе: правишь offers.json, перезапуск не нужен (после деплоя файла)."""
    with OFFERS_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def get_welcome_coupon(cfg: Config) -> dict | None:
    """Купон из переменных WELCOME_COUPON_* (приоритет) поверх welcome_coupon из offers.json.
    Нет кода (или осталась заглушка) → None: людям не отправляем выдуманный код."""
    coupon = dict(load_offers().get("welcome_coupon", {}))
    if cfg.welcome_coupon_code:
        coupon["code"] = cfg.welcome_coupon_code
    if cfg.welcome_coupon_title:
        coupon["title"] = cfg.welcome_coupon_title
    if cfg.welcome_coupon_description:
        coupon["description"] = cfg.welcome_coupon_description
    code = (coupon.get("code") or "").strip()
    if not code or code == PLACEHOLDER_CODE:
        return None
    return coupon


def warn_if_no_coupon(cfg: Config) -> None:
    try:
        coupon = get_welcome_coupon(cfg)
    except Exception:
        log.exception("Не удалось прочитать offers.json")
        return
    if coupon is None:
        log.error("Купон не задан (WELCOME_COUPON_CODE): после номера человек получит подтверждение БЕЗ кода")


def format_coupon(coupon: dict) -> str:
    parts = [f"🎟️ <b>{html.escape(coupon.get('title', 'Cupón'))}</b>"]
    if coupon.get("code"):
        parts.append(f"Código: <code>{html.escape(coupon['code'])}</code>")
    if coupon.get("description"):
        parts.append(html.escape(coupon["description"]))
    return "\n".join(parts)


def format_deals(deals: list[dict]) -> str:
    blocks = []
    for d in deals:
        lines = [f"🔥 <b>{html.escape(d.get('title', ''))}</b>"]
        if d.get("description"):
            lines.append(html.escape(d["description"]))
        if d.get("code"):
            lines.append(f"Código: <code>{html.escape(d['code'])}</code>")
        if d.get("url"):
            lines.append(html.escape(d["url"]))
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)
