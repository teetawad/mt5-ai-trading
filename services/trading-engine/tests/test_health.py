from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


def test_health_check_returns_ok() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["service"] == "trading-engine"
    assert data["timestamp"]


def test_health_mode_is_mt5_demo_never_live() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["mode"] == "MT5_DEMO_ONLY"
    assert data["mode"] != "LIVE"


def test_root_returns_service_info() -> None:
    response = client.get("/")
    assert response.status_code == 200
    data = response.json()
    assert data["service"] == "trading-engine"
    assert data["mode"] == "MT5_DEMO_ONLY"
