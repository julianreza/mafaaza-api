import { describe, expect, test } from "bun:test";
import { EnvError, parseDbEnv, parseEnv } from "../../src/config/env";

const valid = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  JWT_SECRET: "x".repeat(32),
  CORS_ORIGINS: "http://a.test, http://b.test",
};

describe("parseEnv", () => {
  test("valid env is parsed with defaults", () => {
    const env = parseEnv(valid);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe("development");
    expect(env.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(env.REFRESH_TOKEN_TTL_DAYS).toBe(7);
    expect(env.CORS_ORIGINS).toEqual(["http://a.test", "http://b.test"]);
    expect(env.OPENAPI_ENABLED).toBe(true);
    expect(env.TRUST_PROXY).toBe(false);
    expect(env.UPLOAD_DIR).toBe("./storage/uploads");
  });

  test("missing DATABASE_URL names the variable", () => {
    const { DATABASE_URL: _omit, ...rest } = valid;
    try {
      parseEnv(rest);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      expect((e as EnvError).message).toContain("DATABASE_URL");
    }
  });

  test("short JWT_SECRET is rejected", () => {
    expect(() => parseEnv({ ...valid, JWT_SECRET: "short" })).toThrow(/JWT_SECRET/);
  });

  test("boolean and int overrides", () => {
    const env = parseEnv({ ...valid, OPENAPI_ENABLED: "false", TRUST_PROXY: "true", PORT: "8080" });
    expect(env.OPENAPI_ENABLED).toBe(false);
    expect(env.TRUST_PROXY).toBe(true);
    expect(env.PORT).toBe(8080);
  });
});

describe("parseDbEnv / database settings", () => {
  test("DATABASE_PREPARE defaults to true", () => {
    expect(parseDbEnv({}).prepare).toBe(true);
    expect(parseEnv(valid).DATABASE_PREPARE).toBe(true);
  });

  test("DATABASE_PREPARE=false disables prepared statements", () => {
    expect(parseDbEnv({ DATABASE_PREPARE: "false" }).prepare).toBe(false);
    expect(parseEnv({ ...valid, DATABASE_PREPARE: "false" }).DATABASE_PREPARE).toBe(false);
  });

  test("invalid DATABASE_PREPARE names the variable", () => {
    expect(() => parseDbEnv({ DATABASE_PREPARE: "no" })).toThrow(/DATABASE_PREPARE/);
    expect(() => parseEnv({ ...valid, DATABASE_PREPARE: "no" })).toThrow(/DATABASE_PREPARE/);
  });

  test("DATABASE_MIGRATION_URL is optional", () => {
    expect(parseDbEnv({}).migrationUrl).toBeUndefined();
    expect(parseEnv(valid).DATABASE_MIGRATION_URL).toBeUndefined();
  });

  test("valid DATABASE_MIGRATION_URL is returned", () => {
    const url = "postgresql://u:p@host:5432/postgres?sslmode=require";
    expect(parseDbEnv({ DATABASE_MIGRATION_URL: url }).migrationUrl).toBe(url);
    expect(parseEnv({ ...valid, DATABASE_MIGRATION_URL: url }).DATABASE_MIGRATION_URL).toBe(url);
  });

  test("invalid DATABASE_MIGRATION_URL names the variable", () => {
    expect(() => parseDbEnv({ DATABASE_MIGRATION_URL: "mysql://x" })).toThrow(/DATABASE_MIGRATION_URL/);
  });

  test("db issues are reported together with other env issues", () => {
    const { JWT_SECRET: _omit, ...rest } = valid;
    try {
      parseEnv({ ...rest, DATABASE_PREPARE: "no" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      expect((e as EnvError).message).toContain("JWT_SECRET");
      expect((e as EnvError).message).toContain("DATABASE_PREPARE");
    }
  });
});
