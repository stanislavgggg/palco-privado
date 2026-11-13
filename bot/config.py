from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # python-dotenv опционален
    pass

log = logging.getLogger(__name__)

# Версия текста согласия. Меняешь текст согласия в texts.py, увеличь версию:
# в базе будет видно, на какую редакцию согласился каждый человек.
CONSENT_VERSION = "2026-11-v1"


def _find_persona_photo(explicit: str) -> str:
    """Если PERSONA_PHOTO не задан, ищем assets/persona.{png,jpg,jpeg,webp}."""
    if explicit:
        return explicit
    assets = Path(__file__).resolve().parent.parent / "assets"
    for ext in ("png", "jpg", "jpeg", "webp"):
        candidate = assets / f"persona.{ext}"
        if candidate.is_file():
            return str(candidate)
    return ""


def _default_privacy_url(explicit: str) -> str:
    """Если PRIVACY_URL не задан, берём публичный домен Railway (переменная RAILWAY_PUBLIC_DOMAIN)."""
    if explicit:
        return explicit
    domain = os.environ.get("RAILWAY_PUBLIC_DOMAIN", "").strip()
    return f"https://{domain}/privacidad" if domain else ""


def _csv(value: str) -> list[str]:
    return [x.strip() for x in value.split(",") if x.strip()]


def _normalize_db_url(url: str) -> str:
    # Railway отдаёт postgres:// или postgresql://, а SQLAlchemy async нужен драйвер asyncpg
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    if url.startswith("postgresql://"):
        url = "postgresql+asyncpg://" + url[len("postgresql://"):]
    return url


@dataclass(frozen=True)
class Config:
    bot_token: str
    admin_ids: frozenset[int]
    brand_name: str
    privacy_url: str
    persona_name: str
    persona_photo: str
    whatsapp_number: str
    database_url: str
    allowed_regions: frozenset[str] = field(default_factory=frozenset)
    sheets_webhook_url: str = ""
    legal_name: str = ""
    legal_id: str = ""
    legal_address: str = ""
    privacy_email: str = ""
    welcome_coupon_code: str = ""
    welcome_coupon_title: str = ""
    welcome_coupon_description: str = ""


def load_config() -> Config:
    token = os.environ.get("BOT_TOKEN", "").strip()
    if not token:
        raise RuntimeError("BOT_TOKEN не задан")

    cfg = Config(
        bot_token=token,
        admin_ids=frozenset(int(x) for x in _csv(os.environ.get("ADMIN_IDS", "")) if x.lstrip("-").isdigit()),
        brand_name=os.environ.get("BRAND_NAME", "Chollos Hoy").strip(),
        privacy_url=_default_privacy_url(os.environ.get("PRIVACY_URL", "").strip()),
        persona_name=os.environ.get("PERSONA_NAME", "Lucía").strip(),
        persona_photo=_find_persona_photo(os.environ.get("PERSONA_PHOTO", "").strip()),
        whatsapp_number=os.environ.get("WHATSAPP_NUMBER", "").strip(),
        database_url=_normalize_db_url(os.environ.get("DATABASE_URL", "sqlite+aiosqlite:///./data.db").strip()),
        allowed_regions=frozenset(x.upper() for x in _csv(os.environ.get("ALLOWED_REGIONS", ""))),
        sheets_webhook_url=os.environ.get("SHEETS_WEBHOOK_URL", "").strip(),
        legal_name=os.environ.get("LEGAL_NAME", "").strip(),
        legal_id=os.environ.get("LEGAL_ID", "").strip(),
        legal_address=os.environ.get("LEGAL_ADDRESS", "").strip(),
        privacy_email=os.environ.get("PRIVACY_EMAIL", "").strip(),
        welcome_coupon_code=os.environ.get("WELCOME_COUPON_CODE", "").strip(),
        welcome_coupon_title=os.environ.get("WELCOME_COUPON_TITLE", "").strip(),
        welcome_coupon_description=os.environ.get("WELCOME_COUPON_DESCRIPTION", "").strip(),
    )

    if not cfg.privacy_url:
        log.warning("PRIVACY_URL пуст: в тексте согласия не будет ссылки на политику конфиденциальности (нужна по RGPD)")
    if not cfg.sheets_webhook_url:
        log.warning("SHEETS_WEBHOOK_URL пуст: лиды не будут отправляться в Google Sheets (останутся только в базе, /export)")
    missing = [n for n, v in (("LEGAL_NAME", cfg.legal_name), ("LEGAL_ID", cfg.legal_id),
                              ("LEGAL_ADDRESS", cfg.legal_address)) if not v]
    if missing:
        log.warning("Политика приватности: не заданы %s, на странице будет «[pendiente de completar]»", ", ".join(missing))
    if not cfg.privacy_email:
        log.warning("PRIVACY_EMAIL не задан: в политике контакт указан через бота и почтовый адрес (лучше задать почту)")
    if not cfg.admin_ids:
        log.warning("ADMIN_IDS пуст: команды /stats, /export и /broadcast никому не доступны")
    return cfg
