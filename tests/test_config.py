from bot.config import _normalize_db_url


def test_railway_urls_get_asyncpg_driver():
    assert _normalize_db_url("postgres://u:p@h:5432/db") == "postgresql+asyncpg://u:p@h:5432/db"
    assert _normalize_db_url("postgresql://u:p@h:5432/db") == "postgresql+asyncpg://u:p@h:5432/db"
    assert _normalize_db_url("sqlite+aiosqlite:///x.db") == "sqlite+aiosqlite:///x.db"


def test_persona_photo_autodetect(tmp_path, monkeypatch):
    import bot.config as c

    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "persona.png").write_bytes(b"x")
    monkeypatch.setattr(c, "Path", lambda *_a, **_k: tmp_path / "bot" / "config.py")  # __file__ -> tmp_path/bot/config.py
    assert c._find_persona_photo("").endswith("persona.png")
    assert c._find_persona_photo("custom.jpg") == "custom.jpg"
