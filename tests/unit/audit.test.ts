import { describe, expect, test } from "bun:test";
import { redact } from "../../src/lib/audit";

describe("audit redaction", () => {
  test("removes sensitive keys at any depth and keeps others", () => {
    const input = {
      name: "Admin",
      password: "secret1",
      nested: { refreshToken: "r", tokenHash: "h", keep: 1, deeper: [{ newPassword: "x", ok: true }] },
      PasswordHash: "y",
    };
    expect(redact(input)).toEqual({ name: "Admin", nested: { keep: 1, deeper: [{ ok: true }] } });
  });

  test("dates become ISO strings, primitives unchanged", () => {
    expect(redact({ at: new Date("2026-01-01T00:00:00Z") })).toEqual({ at: "2026-01-01T00:00:00.000Z" });
    expect(redact(5)).toBe(5);
    expect(redact(null)).toBeNull();
  });
});
