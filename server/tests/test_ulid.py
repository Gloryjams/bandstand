import time

from server.ulid import new_ulid


def test_ulid_length():
    assert len(new_ulid()) == 26


def test_ulid_uppercase_alphanum():
    u = new_ulid()
    assert u.isalnum()
    assert u == u.upper()


def test_ulid_unique():
    ids = {new_ulid() for _ in range(1000)}
    assert len(ids) == 1000


def test_ulid_lexicographically_increasing():
    a = new_ulid()
    time.sleep(0.05)
    b = new_ulid()
    assert b > a
    assert b[:10] >= a[:10]
