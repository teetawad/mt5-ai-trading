"""Read/write system_settings from the trading engine.

The trading engine only needs to READ settings (kill switch, thresholds, etc.).
It never modifies settings — that is the API's responsibility.
"""

import json
from typing import Any

import asyncpg


async def get_setting(
    conn: asyncpg.Connection,
    key: str,
) -> dict[str, Any] | None:
    row = await conn.fetchrow(
        "SELECT key, value, description, updated_at, updated_by "
        "FROM system_settings WHERE key = $1",
        key,
    )
    if row is None:
        return None
    return {
        "key": row["key"],
        "value": json.loads(row["value"]) if isinstance(row["value"], str) else row["value"],
        "description": row["description"],
        "updated_at": row["updated_at"],
        "updated_by": row["updated_by"],
    }


async def get_setting_value(
    conn: asyncpg.Connection,
    key: str,
    default: Any = None,
) -> Any:
    setting = await get_setting(conn, key)
    if setting is None:
        return default
    return setting["value"]


async def is_kill_switch_enabled(conn: asyncpg.Connection) -> bool:
    value = await get_setting_value(conn, "trading_kill_switch_enabled", default=True)
    return value is not False


async def get_all_settings(conn: asyncpg.Connection) -> list[dict[str, Any]]:
    rows = await conn.fetch(
        "SELECT key, value, description, updated_at, updated_by "
        "FROM system_settings ORDER BY key"
    )
    return [
        {
            "key": row["key"],
            "value": json.loads(row["value"]) if isinstance(row["value"], str) else row["value"],
            "description": row["description"],
            "updated_at": row["updated_at"],
            "updated_by": row["updated_by"],
        }
        for row in rows
    ]
