import unittest

from auth import normalize_username, verify_password


class AuthenticationTests(unittest.TestCase):
    def test_normalize_username(self):
        self.assertEqual(normalize_username("alice"), "alice")

    def test_verify_password(self):
        self.assertTrue(verify_password("secret", "secret"))


if __name__ == "__main__":
    unittest.main()
