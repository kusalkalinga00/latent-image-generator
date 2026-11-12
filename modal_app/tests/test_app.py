import base64
import io
from decimal import Decimal

from PIL import Image

from modal_app import app as service


def png_bytes(mode: str = "RGBA", color=(255, 0, 0, 128)) -> bytes:
    buffer = io.BytesIO()
    Image.new(mode, (4, 4), color).save(buffer, "PNG")
    return buffer.getvalue()


def test_snap_alpha_clamps_the_near_zero_haze():
    image = Image.new("RGBA", (3, 1))
    image.putdata([(255, 0, 0, 0), (255, 0, 0, 7), (255, 0, 0, 8)])
    buffer = io.BytesIO()
    image.save(buffer, "PNG")

    out = Image.open(io.BytesIO(service._snap_alpha(buffer.getvalue())))
    assert out.getchannel("A").tobytes() == bytes([0, 0, 8])


def test_flatten_composites_alpha_onto_white():
    image = Image.new("RGBA", (2, 1))
    image.putdata([(255, 0, 0, 0), (0, 255, 0, 255)])
    buffer = io.BytesIO()
    image.save(buffer, "PNG")

    out = Image.open(io.BytesIO(service._flatten(buffer.getvalue())))
    assert out.mode == "RGB"
    assert out.getpixel((0, 0)) == (255, 255, 255)
    assert out.getpixel((1, 0)) == (0, 255, 0)


def test_useful_alpha_reports_what_the_model_returned():
    opaque = Image.new("RGBA", (2, 2), (10, 20, 30, 255))
    cutout = Image.new("RGBA", (2, 2), (10, 20, 30, 100))
    rgb = Image.new("RGB", (2, 2), (10, 20, 30))

    assert service._useful_alpha(png_from(opaque)) is False
    assert service._useful_alpha(png_from(cutout)) is True
    assert service._useful_alpha(png_from(rgb)) is False


def png_from(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def test_decode_images_accepts_a_png_and_rejects_junk():
    data = png_bytes()
    encoded = base64.b64encode(data).decode("ascii")

    decoded, error = service._decode_images([encoded])
    assert error is None
    assert decoded == [data]

    assert service._decode_images(["not-base64!"])[1] is not None
    not_an_image = base64.b64encode(b"not an image").decode("ascii")
    assert service._decode_images([not_an_image])[1] is not None


def test_jobs_path_never_escapes_the_results_volume():
    path = service._jobs_path("../../etc/passwd")
    assert path.startswith(service.RESULTS_PATH)
    assert ".." not in path
    assert path.endswith(".json")


def test_estimate_edits_separates_the_cold_and_warm_cases():
    assert service.estimate_edits(Decimal("0"), Decimal("3.95")) == (0, 0)
    assert service.estimate_edits(Decimal("30"), Decimal("0")) == (0, 0)

    cold, warm = service.estimate_edits(Decimal("30"), Decimal("3.95"))
    assert cold == 329
    assert warm > cold


def test_daily_limit_stops_at_the_cap(monkeypatch):
    monkeypatch.setattr(service, "RATES", {})
    monkeypatch.setattr(service, "DAILY_RENDER_MAX", 2)

    assert [service._daily_limit()[0] for _ in range(3)] == [True, True, False]


def test_credit_gate_blocks_below_one_dollar(monkeypatch):
    for remaining, allowed in [(12.34, True), (1.00, True), (0.99, False), (0.0, False)]:
        monkeypatch.setattr(
            service,
            "_cached_credit",
            lambda remaining=remaining: {"ok": True, "remaining_usd": remaining},
        )
        assert service._credit_gate()[0] is allowed

    monkeypatch.setattr(service, "_cached_credit", lambda: {"ok": False})
    assert service._credit_gate()[0] is True


def test_cached_credit_reuses_a_snapshot_until_invalidated(monkeypatch):
    calls = []

    def snapshot():
        calls.append(1)
        return {"ok": True, "remaining_usd": 5.0}

    monkeypatch.setattr(service, "RATES", {})
    monkeypatch.setattr(service, "credit_snapshot", snapshot)

    assert service._cached_credit()["remaining_usd"] == 5.0
    assert service._cached_credit()["remaining_usd"] == 5.0
    assert len(calls) == 1

    service._invalidate_credit_cache()
    service._cached_credit()
    assert len(calls) == 2


def test_rate_limit_keys_cannot_collide_with_other_namespaces(monkeypatch):
    monkeypatch.setattr(service, "RATES", {"credit:snapshot": {"at": 1, "body": {}}})
    monkeypatch.setattr(service, "RATE_LIMIT_MAX", 1)

    assert service._rate_limit("credit:snapshot")[0] is True
    assert isinstance(service.RATES["credit:snapshot"], dict)
    assert "ip:credit:snapshot" in service.RATES
