"""Мини-сайт: отдаёт политику конфиденциальности на домене Railway (https://<домен>/privacidad)."""
from __future__ import annotations

import html
import logging
import os
from pathlib import Path

from aiohttp import web

from .config import Config

log = logging.getLogger(__name__)

TEMPLATE = Path(__file__).resolve().parent.parent / "legal" / "privacidad_es.html"
# Меняешь текст политики: обнови дату здесь (и CONSENT_VERSION в config.py, если изменился текст согласия)
POLICY_UPDATED = "13 de noviembre de 2026"
MISSING = '<mark>[pendiente de completar]</mark>'


def contact_values(cfg: Config) -> dict[str, str]:
    """Если почты нет, контакт идёт через самого бота и почтовый адрес компании, без пустых заглушек."""
    email = html.escape(cfg.privacy_email) if cfg.privacy_email else ""
    if email:
        return {
            "CONTACT_LINE": f"Correo de contacto para privacidad: <strong>{email}</strong>",
            "CONTACT_WAY": f"enviando un correo a {email}",
            "CONTACT_WAY_STRONG": f"escribiendo a <strong>{email}</strong>",
            "CONTACT_FOOTER": f"Contacto: {email}",
        }
    way = "escribiéndonos a través de este bot de Telegram o por correo postal a nuestro domicilio"
    return {
        "CONTACT_LINE": "Contacto para privacidad: a través de este bot de Telegram o por correo postal al domicilio indicado.",
        "CONTACT_WAY": way,
        "CONTACT_WAY_STRONG": way,
        "CONTACT_FOOTER": "Contacto: a través de este bot de Telegram.",
    }


def render_policy(cfg: Config) -> str:
    def val(v: str) -> str:
        return html.escape(v) if v else MISSING

    values = {
        "BRAND_NAME": html.escape(cfg.brand_name),
        "LEGAL_NAME": val(cfg.legal_name),
        "LEGAL_ID": val(cfg.legal_id),
        "LEGAL_ADDRESS": val(cfg.legal_address),
        **contact_values(cfg),
        "UPDATED": POLICY_UPDATED,
    }
    page = TEMPLATE.read_text(encoding="utf-8")
    for key, value in values.items():
        page = page.replace("{{" + key + "}}", value)
    return page


def build_app(cfg: Config) -> web.Application:
    page = render_policy(cfg)

    async def policy(_: web.Request) -> web.Response:
        return web.Response(text=page, content_type="text/html", charset="utf-8")

    async def root(_: web.Request) -> web.Response:
        raise web.HTTPFound("/privacidad")

    async def health(_: web.Request) -> web.Response:
        return web.json_response({"ok": True})

    app = web.Application()
    app.router.add_get("/", root)
    app.router.add_get("/privacidad", policy)
    app.router.add_get("/healthz", health)
    return app


async def start_site(cfg: Config) -> web.AppRunner | None:
    """Railway задаёт PORT. Если PORT нет (локальный запуск), сайт не поднимается."""
    port = os.environ.get("PORT", "").strip()
    if not port.isdigit():
        log.info("PORT не задан: страница политики не поднимается")
        return None
    runner = web.AppRunner(build_app(cfg))
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", int(port)).start()
    log.info("политика приватности доступна на порту %s по пути /privacidad", port)
    return runner
