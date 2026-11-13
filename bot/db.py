from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

metadata = sa.MetaData()

users = sa.Table(
    "users",
    metadata,
    sa.Column("telegram_id", sa.BigInteger, primary_key=True, autoincrement=False),
    sa.Column("username", sa.String(64)),
    sa.Column("first_name", sa.String(128)),
    sa.Column("language_code", sa.String(16)),
    sa.Column("source", sa.String(128)),            # из ссылки t.me/bot?start=<source>, первая фиксируется навсегда
    sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
    sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
    sa.Column("phone_e164", sa.String(20)),
    sa.Column("phone_region", sa.String(4)),
    sa.Column("phone_valid", sa.Boolean),
    sa.Column("consent_at", sa.DateTime(timezone=True)),
    sa.Column("consent_version", sa.String(32)),
    sa.Column("opted_out_at", sa.DateTime(timezone=True)),
    sa.Column("sheet_synced_at", sa.DateTime(timezone=True)),  # когда лид успешно ушёл в Google Sheets
)


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


@dataclass
class Stats:
    total_started: int
    with_phone: int
    active: int          # с номером и не отписались
    opted_out: int
    by_region: list[tuple[str, int]]
    by_source: list[tuple[str, int, int]]  # source, started, phones


@dataclass
class Window:
    """Когорта: люди, нажавшие /start за период, и сколько из них поделились номером."""
    started: int
    phones: int
    by_source: list[tuple[str, int, int]]


class Database:
    def __init__(self, url: str):
        self.engine: AsyncEngine = create_async_engine(url, pool_pre_ping=True)

    async def init(self) -> None:
        async with self.engine.begin() as conn:
            await conn.run_sync(metadata.create_all)
            # create_all не добавляет колонки в уже существующую таблицу: докидываем сами
            cols = await conn.run_sync(lambda c: {col["name"] for col in sa.inspect(c).get_columns("users")})
            if "sheet_synced_at" not in cols:
                await conn.execute(sa.text("ALTER TABLE users ADD COLUMN sheet_synced_at TIMESTAMP WITH TIME ZONE"))

    async def close(self) -> None:
        await self.engine.dispose()

    async def touch_user(
        self,
        telegram_id: int,
        username: str | None,
        first_name: str | None,
        language_code: str | None,
        source: str | None,
    ) -> None:
        now = utcnow()
        async with self.engine.begin() as conn:
            row = (await conn.execute(sa.select(users.c.source).where(users.c.telegram_id == telegram_id))).first()
            if row is None:
                await conn.execute(
                    sa.insert(users).values(
                        telegram_id=telegram_id,
                        username=username,
                        first_name=first_name,
                        language_code=language_code,
                        source=source,
                        started_at=now,
                        last_seen_at=now,
                    )
                )
            else:
                values = dict(username=username, first_name=first_name, language_code=language_code, last_seen_at=now)
                if row.source is None and source:
                    values["source"] = source
                await conn.execute(sa.update(users).where(users.c.telegram_id == telegram_id).values(**values))

    async def save_phone(
        self, telegram_id: int, e164: str, region: str | None, valid: bool, consent_version: str
    ) -> None:
        now = utcnow()
        async with self.engine.begin() as conn:
            await conn.execute(
                sa.update(users)
                .where(users.c.telegram_id == telegram_id)
                .values(
                    phone_e164=e164,
                    phone_region=region,
                    phone_valid=valid,
                    consent_at=now,
                    consent_version=consent_version,
                    opted_out_at=None,
                    sheet_synced_at=None,
                )
            )

    async def get_user(self, telegram_id: int):
        async with self.engine.connect() as conn:
            return (await conn.execute(sa.select(users).where(users.c.telegram_id == telegram_id))).first()

    async def mark_synced(self, telegram_ids: list[int]) -> None:
        if not telegram_ids:
            return
        async with self.engine.begin() as conn:
            await conn.execute(
                sa.update(users).where(users.c.telegram_id.in_(telegram_ids)).values(sheet_synced_at=utcnow())
            )

    async def unsynced(self) -> list:
        """Лиды с номером, без отписки, которые ещё не ушли в таблицу."""
        async with self.engine.connect() as conn:
            rows = await conn.execute(
                sa.select(users).where(
                    users.c.phone_e164.is_not(None),
                    users.c.opted_out_at.is_(None),
                    users.c.sheet_synced_at.is_(None),
                ).order_by(users.c.consent_at)
            )
            return list(rows)

    async def opt_out(self, telegram_id: int) -> bool:
        async with self.engine.begin() as conn:
            res = await conn.execute(
                sa.update(users).where(users.c.telegram_id == telegram_id).values(opted_out_at=utcnow())
            )
            return res.rowcount > 0

    async def erase(self, telegram_id: int) -> bool:
        async with self.engine.begin() as conn:
            res = await conn.execute(sa.delete(users).where(users.c.telegram_id == telegram_id))
            return res.rowcount > 0

    async def broadcast_targets(self) -> list[int]:
        """Только те, кто делился номером (дал согласие) и не отписался."""
        async with self.engine.connect() as conn:
            rows = await conn.execute(
                sa.select(users.c.telegram_id).where(
                    users.c.phone_e164.is_not(None), users.c.opted_out_at.is_(None)
                )
            )
            return [r.telegram_id for r in rows]

    async def export_rows(self) -> list[sa.Row]:
        async with self.engine.connect() as conn:
            rows = await conn.execute(
                sa.select(
                    users.c.phone_e164,
                    users.c.phone_region,
                    users.c.phone_valid,
                    users.c.first_name,
                    users.c.username,
                    users.c.language_code,
                    users.c.source,
                    users.c.consent_at,
                    users.c.consent_version,
                    users.c.telegram_id,
                )
                .where(users.c.phone_e164.is_not(None), users.c.opted_out_at.is_(None))
                .order_by(users.c.consent_at)
            )
            return list(rows)

    async def window(self, since: dt.datetime, limit: int = 15) -> Window:
        src = sa.func.coalesce(users.c.source, "(sin source)")
        async with self.engine.connect() as conn:
            cond = users.c.started_at >= since
            started = (await conn.execute(sa.select(sa.func.count()).select_from(users).where(cond))).scalar_one()
            phones = (
                await conn.execute(
                    sa.select(sa.func.count()).select_from(users).where(cond, users.c.phone_e164.is_not(None))
                )
            ).scalar_one()
            rows = await conn.execute(
                sa.select(src, sa.func.count(), sa.func.count(users.c.phone_e164))
                .where(cond)
                .group_by(src)
                .order_by(sa.func.count().desc())
                .limit(limit)
            )
            return Window(started, phones, [(r[0], r[1], r[2]) for r in rows])

    async def stats(self) -> Stats:
        async with self.engine.connect() as conn:
            total = (await conn.execute(sa.select(sa.func.count()).select_from(users))).scalar_one()
            with_phone = (
                await conn.execute(sa.select(sa.func.count()).select_from(users).where(users.c.phone_e164.is_not(None)))
            ).scalar_one()
            opted_out = (
                await conn.execute(
                    sa.select(sa.func.count())
                    .select_from(users)
                    .where(users.c.phone_e164.is_not(None), users.c.opted_out_at.is_not(None))
                )
            ).scalar_one()
            regions = await conn.execute(
                sa.select(users.c.phone_region, sa.func.count())
                .where(users.c.phone_e164.is_not(None), users.c.opted_out_at.is_(None))
                .group_by(users.c.phone_region)
                .order_by(sa.func.count().desc())
            )
            sources = await conn.execute(
                sa.select(
                    sa.func.coalesce(users.c.source, "(sin source)"),
                    sa.func.count(),
                    sa.func.count(users.c.phone_e164),
                )
                .group_by(sa.func.coalesce(users.c.source, "(sin source)"))
                .order_by(sa.func.count().desc())
                .limit(20)
            )
            return Stats(
                total_started=total,
                with_phone=with_phone,
                active=with_phone - opted_out,
                opted_out=opted_out,
                by_region=[(r[0] or "?", r[1]) for r in regions],
                by_source=[(r[0], r[1], r[2]) for r in sources],
            )
