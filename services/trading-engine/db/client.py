"""asyncpg connection pool for the trading engine.

Usage:
    pool = await create_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT NOW()")
    await pool.close()
"""

import os

import asyncpg

_pool: asyncpg.Pool | None = None


async def create_pool(dsn: str | None = None) -> asyncpg.Pool:
    url = dsn or os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL environment variable is required")
    return await asyncpg.create_pool(dsn=url, min_size=1, max_size=10)


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await create_pool()
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
