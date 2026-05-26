"""Delta + zigzag varint encoder for PTS arrays.

Wire format:
    byte 0: header
        bit 0 (LSB): unit (0 = milliseconds, 1 = microseconds)
        bit 1: shorthand flag (0 = dense, 1 = CFR shorthand)
    body (dense):     stream of zigzag varint deltas
    body (shorthand): varint(fps_x1000), varint(count)
"""
from __future__ import annotations

HEADER_UNIT_MICROS = 0b01
HEADER_SHORTHAND = 0b10


def _varint_encode(value: int) -> bytes:
    out = bytearray()
    while value >= 0x80:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    out.append(value & 0x7F)
    return bytes(out)


def _varint_decode(buf: memoryview, offset: int) -> tuple[int, int]:
    value = 0
    shift = 0
    while True:
        byte = buf[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if not (byte & 0x80):
            return value, offset
        shift += 7


def _zigzag_encode(value: int) -> int:
    return (value << 1) ^ (value >> 63)


def _zigzag_decode(value: int) -> int:
    return (value >> 1) ^ -(value & 1)


class PtsCodec:
    def encode(self, pts: list[float]) -> bytes:
        # Choose unit: μs if any value isn't representable in ms within 1 unit.
        use_micros = any(abs(p * 1000 - round(p * 1000)) > 0.5 for p in pts)
        scale = 1_000_000 if use_micros else 1_000
        scaled = [round(p * scale) for p in pts]

        header = HEADER_UNIT_MICROS if use_micros else 0
        out = bytearray([header])
        prev = 0
        for value in scaled:
            delta = value - prev
            out += _varint_encode(_zigzag_encode(delta))
            prev = value
        return bytes(out)

    def decode(self, blob: bytes) -> list[float]:
        if not blob:
            return []
        view = memoryview(blob)
        header = view[0]
        scale = 1_000_000 if (header & HEADER_UNIT_MICROS) else 1_000
        result: list[float] = []
        offset = 1
        prev = 0
        while offset < len(view):
            raw, offset = _varint_decode(view, offset)
            delta = _zigzag_decode(raw)
            prev += delta
            result.append(prev / scale)
        return result
