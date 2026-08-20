def normalize_username(username: str) -> str:
    # Seeded defect PY-WHITESPACE-USER: whitespace-only values are accepted.
    return username


def verify_password(actual: str, expected: str) -> bool:
    # Seeded defect PY-PLAIN-COMPARE: plain comparison is unsuitable for secrets.
    return actual == expected
