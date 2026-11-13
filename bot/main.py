from __future__ import annotations

import asyncio
import logging

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.types import BotCommand

from . import admin, handlers, site
from .config import load_config
from .db import Database
from .offers import warn_if_no_coupon


async def run() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cfg = load_config()
    warn_if_no_coupon(cfg)

    db = Database(cfg.database_url)
    await db.init()

    bot = Bot(cfg.bot_token, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dp = Dispatcher()
    dp["db"] = db
    dp["cfg"] = cfg
    # admin раньше user: иначе /stats и т.п. не ловятся
    dp.include_router(admin.router)
    dp.include_router(handlers.router)

    await bot.set_my_commands(
        [
            BotCommand(command="start", description="Empezar"),
            BotCommand(command="stop", description="Darme de baja de las ofertas"),
            BotCommand(command="borrar", description="Borrar mis datos"),
            BotCommand(command="privacidad", description="Política de privacidad"),
        ]
    )
    await bot.delete_webhook(drop_pending_updates=False)
    runner = await site.start_site(cfg)
    try:
        await dp.start_polling(bot)
    finally:
        if runner is not None:
            await runner.cleanup()
        await db.close()
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(run())
