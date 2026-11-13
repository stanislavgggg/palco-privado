"""Все тексты бота (испанский). Меняй здесь. При смене текста согласия увеличь CONSENT_VERSION в config.py."""
from __future__ import annotations

import html

BTN_SHARE = "📲 Recibir mis cupones"
BTN_DEALS = "🔥 Chollos de hoy"
BTN_STOP = "🔕 Darme de baja"


def welcome(persona: str, brand: str, privacy_url: str, first_name: str | None) -> str:
    name = f", {html.escape(first_name)}" if first_name else ""
    privacy = f' Más info: <a href="{html.escape(privacy_url)}">política de privacidad</a>.' if privacy_url else ""
    return (
        f"¡Hola{name}! 👋 Soy {html.escape(persona)}.\n\n"
        "Cada día rastreo chollos, errores de precio, cupones y promociones, "
        "y te los mando directamente a tu WhatsApp para que no se te escape ninguno. 🔥\n\n"
        "Pulsa el botón de abajo y te envío ahora mismo tu primer código de descuento 👇\n\n"
        f"🔒 <i>Al pulsar «Recibir mis cupones» compartes tu número de teléfono y aceptas recibir "
        f"ofertas y promociones por WhatsApp de {html.escape(brand)}. "
        f"Puedes darte de baja cuando quieras con /stop.{privacy}</i>"
    )


def reask_contact() -> str:
    return "Para enviarte los cupones solo tienes que pulsar el botón de abajo 👇"


def foreign_contact() -> str:
    return "Ese número no es el tuyo 🙈 Pulsa el botón «📲 Recibir mis cupones» para compartir el tuyo."


def bad_phone() -> str:
    return "No he podido validar ese número. Inténtalo de nuevo con el botón de abajo."


def region_not_allowed() -> str:
    return "Por ahora las ofertas por WhatsApp solo están disponibles para otros países. ¡Gracias por tu interés!"


def success(first_name: str | None, coupon_block: str, whatsapp_number: str) -> str:
    name = f", {html.escape(first_name)}" if first_name else ""
    save = (
        f"\n\n📌 Guarda este número en tus contactos para recibir los mensajes: <b>{html.escape(whatsapp_number)}</b>"
        if whatsapp_number
        else ""
    )
    coupon = f"{coupon_block}\n\n" if coupon_block else ""
    return (
        f"✅ ¡Listo{name}! Ya estás dentro.\n\n"
        f"{coupon}"
        "A partir de ahora te aviso por WhatsApp de los mejores chollos, cupones y promociones. 🔥"
        f"{save}\n\n"
        "Cuando quieras ver las ofertas del día, pulsa «🔥 Chollos de hoy». "
        "Para dejar de recibir mensajes: /stop"
    )


def no_deals() -> str:
    return "Hoy todavía no hay ofertas nuevas. ¡Vuelve en un rato! 🔔"


def stopped() -> str:
    return (
        "Hecho: no te enviaremos más ofertas ni promociones. "
        "Si quieres volver, escribe /start. Si quieres que borremos tu número, usa /borrar."
    )


def erased() -> str:
    return "He borrado tus datos (incluido tu número de teléfono). ¡Gracias!"


def need_start() -> str:
    return "Escribe /start para empezar 👋"


def privacy(url: str) -> str:
    if not url:
        return "La política de privacidad aún no está disponible. Escríbenos y te la enviamos."
    return f'🔒 Aquí tienes nuestra <a href="{html.escape(url)}">política de privacidad</a>.'
