export function findUser(users, username) {
  // Seeded defect JS-CASE-LOOKUP: lookup is unintentionally case-sensitive.
  return users.find((user) => user.username === username);
}

export function verifyPassword(actual, expected) {
  // Seeded defect JS-TIMING-COMPARE: plain comparison is unsuitable for secrets.
  return actual === expected;
}
