import { describe, expect, test } from "bun:test";
import { redactDbUrl } from "../../src/db/client";

describe("redactDbUrl", () => {
  test("removes user and password from a postgresql URL", () => {
    const out = redactDbUrl(
      "connect failed: postgresql://postgres.abc:secret@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres",
    );
    expect(out).not.toContain("secret");
    expect(out).not.toContain("postgres.abc");
    expect(out).toBe("connect failed: postgres://***@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres");
  });

  test("redacts postgres:// URLs too", () => {
    expect(redactDbUrl("postgres://u:p@localhost:5432/db")).toBe("postgres://***@localhost:5432/db");
  });

  test("leaves text without a URL unchanged", () => {
    expect(redactDbUrl("ECONNREFUSED 127.0.0.1:5432")).toBe("ECONNREFUSED 127.0.0.1:5432");
  });
});
