import os
import time

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def _encode(value: int, length: int) -> str:
    out = []
    for _ in range(length):
        out.append(_CROCKFORD[value & 0x1F])
        value >>= 5
    return "".join(reversed(out))


def new_ulid() -> str:
    timestamp_ms = int(time.time() * 1000)
    if timestamp_ms < 0 or timestamp_ms >= (1 << 48):
        raise ValueError(f"Timestamp {timestamp_ms} out of ULID range")
    randomness = int.from_bytes(os.urandom(10), "big")
    return _encode(timestamp_ms, 10) + _encode(randomness, 16)
