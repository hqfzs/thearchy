import assert from "node:assert/strict";
import test from "node:test";
import { findUser, verifyPassword } from "./auth.js";

test("finds exact username", () => {
  assert.equal(findUser([{ username: "alice" }], "alice")?.username, "alice");
});

test("verifies matching password", () => {
  assert.equal(verifyPassword("secret", "secret"), true);
});
