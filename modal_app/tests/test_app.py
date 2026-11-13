import base64
import io
import json
import time
from decimal import Decimal
from pathlib import Path

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


def test_prepare_output_cleans_alpha_on_the_cpu_side():
    cutout = Image.new("RGBA", (2, 2), (10, 20, 30, 100))
    opaque = Image.new("RGBA", (2, 2), (10, 20, 30, 255))

    png, transparent = service._prepare_output(png_from(cutout), True)
    assert transparent is True
    assert Image.open(io.BytesIO(png)).mode == "RGBA"

    png, transparent = service._prepare_output(png_from(opaque), True)
    assert transparent is False

    png, transparent = service._prepare_output(png_from(opaque), False)
    assert transparent is False
    assert Image.open(io.BytesIO(png)).mode == "RGB"


def test_stored_result_replays_a_fresh_render(monkeypatch, tmp_path):
    class FakeResults:
        def reload(self):
            pass

    monkeypatch.setattr(service, "RESULTS", FakeResults())
    monkeypatch.setattr(service, "RESULTS_PATH", str(tmp_path))

    job_id = "job-12345678"
    path = Path(service._jobs_path(job_id))
    path.write_text(json.dumps({"ok": True, "image_b64": "x", "at": time.time()}))
    assert service._stored_result(job_id)["image_b64"] == "x"

    path.write_text(
        json.dumps(
            {
                "ok": True,
                "image_b64": "x",
                "at": time.time() - service.RESULTS_TTL_S - 1,
            }
        )
    )
    assert service._stored_result(job_id) is None


def test_in_flight_marker_blocks_a_duplicate_then_clears(monkeypatch):
    monkeypatch.setattr(service, "RATES", {})
    job_id = "job-12345678"

    assert service._in_flight(job_id) is False
    service._mark_in_flight(job_id)
    assert service._in_flight(job_id) is True
    service._clear_in_flight(job_id)
    assert service._in_flight(job_id) is False


def test_in_flight_marker_expires(monkeypatch):
    monkeypatch.setattr(service, "RATES", {})
    job_id = "job-12345678"
    service.RATES[f"inflight:{job_id}"] = time.time() - service.INFLIGHT_TTL_S - 1

    assert service._in_flight(job_id) is False


def test_in_flight_count_reports_fresh_jobs(monkeypatch):
    monkeypatch.setattr(service, "RATES", {})
    service._mark_in_flight("job-aaaa1111")
    service._mark_in_flight("job-bbbb2222")
    assert service._in_flight_count() == 2

    service._clear_in_flight("job-aaaa1111")
    assert service._in_flight_count() == 1

    service.RATES["inflight:job-cccc3333"] = time.time() - service.INFLIGHT_TTL_S - 1
    assert service._in_flight_count() == 1
