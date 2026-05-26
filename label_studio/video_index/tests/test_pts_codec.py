import pytest
from video_index.services.codec import PtsCodec


def test_vfr_round_trip_basic():
    codec = PtsCodec()
    pts = [0.0, 0.0333, 0.0667, 0.1, 0.15, 0.21]
    encoded = codec.encode(pts)
    assert isinstance(encoded, bytes)
    decoded = codec.decode(encoded)
    assert len(decoded) == len(pts)
    for a, b in zip(decoded, pts):
        assert a == pytest.approx(b, abs=1e-3)


def test_round_trip_preserves_monotonicity():
    codec = PtsCodec()
    pts = [0.0, 0.0333, 0.0667, 0.1, 0.15, 0.21]
    decoded = codec.decode(codec.encode(pts))
    for i in range(1, len(decoded)):
        assert decoded[i] >= decoded[i - 1]


def test_cfr_shorthand_round_trip():
    codec = PtsCodec()
    shorthand = codec.encode_cfr_shorthand(fps=29.97, count=1800)
    fps, count = codec.decode_cfr_shorthand(shorthand)
    assert fps == pytest.approx(29.97, abs=1e-3)
    assert count == 1800


def test_decode_detects_shorthand_header():
    codec = PtsCodec()
    blob = codec.encode_cfr_shorthand(fps=30.0, count=900)
    assert codec.is_shorthand(blob) is True
    dense = codec.encode([0.0, 0.033, 0.066])
    assert codec.is_shorthand(dense) is False
