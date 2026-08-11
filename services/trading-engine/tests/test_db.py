"""Database connectivity and repository tests for the trading engine.

Skipped automatically when TEST_DATABASE_URL is not set.
"""

import os

import pytest
import pytest_asyncio

TEST_DB_URL = os.environ.get("TEST_DATABASE_URL")
skip_no_db = pytest.mark.skipif(
    not TEST_DB_URL,
    reason="TEST_DATABASE_URL not set",
)


@pytest.fixture(scope="module")
def anyio_backend():
    return "asyncio"


@pytest_asyncio.fixture(scope="module")
async def pool():
    if not TEST_DB_URL:
        pytest.skip("TEST_DATABASE_URL not set")
    from db.client import create_pool

    p = await create_pool(dsn=TEST_DB_URL)
    yield p
    await p.close()


@skip_no_db
@pytest.mark.anyio
async def test_db_connection(pool):
    """Trading engine can connect to PostgreSQL and query."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT NOW() AS now, current_database() AS db")
    assert row is not None
    assert row["now"] is not None
    assert row["db"] is not None


@skip_no_db
@pytest.mark.anyio
async def test_system_settings_readable(pool):
    """Trading engine can read system_settings from the database."""
    from db.repositories.system_settings import get_setting_value, is_kill_switch_enabled

    async with pool.acquire() as conn:
        mode = await get_setting_value(conn, "trading_mode")
        assert mode == "PAPER", "Trading mode must always be PAPER"

        kill_switch = await is_kill_switch_enabled(conn)
        assert isinstance(kill_switch, bool)


@skip_no_db
@pytest.mark.anyio
async def test_get_all_settings_returns_list(pool):
    from db.repositories.system_settings import get_all_settings

    async with pool.acquire() as conn:
        settings = await get_all_settings(conn)

    assert len(settings) >= 12
    keys = [s["key"] for s in settings]
    assert "trading_mode" in keys
    assert "trading_kill_switch_enabled" in keys
