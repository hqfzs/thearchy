from auth import normalize_username, verify_password


def test_normalize_username():
    assert normalize_username("alice") == "alice"


def test_verify_password():
    assert verify_password("secret", "secret") is True
