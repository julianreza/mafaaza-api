import { describe, expect, test } from "bun:test";
import { LoginRateLimiter } from "../../src/lib/rate-limit";

describe("LoginRateLimiter", () => {
  test("5th failure locks, stays locked 15 minutes, then opens", () => {
    let now = 1_000_000;
    const rl = new LoginRateLimiter({ now: () => now });
    for (let i = 0; i < 4; i++) rl.recordFailure("1.1.1.1");
    expect(rl.retryAfter("1.1.1.1")).toBe(0);
    rl.recordFailure("1.1.1.1");
    expect(rl.retryAfter("1.1.1.1")).toBe(900);
    now += 14 * 60_000;
    expect(rl.retryAfter("1.1.1.1")).toBe(60);
    now += 60_000;
    expect(rl.retryAfter("1.1.1.1")).toBe(0);
  });

  test("failures outside the 15-minute window do not count", () => {
    let now = 0;
    const rl = new LoginRateLimiter({ now: () => now });
    for (let i = 0; i < 4; i++) rl.recordFailure("ip");
    now += 16 * 60_000;
    rl.recordFailure("ip");
    expect(rl.retryAfter("ip")).toBe(0);
  });

  test("success clears the counter; keys are independent", () => {
    const rl = new LoginRateLimiter();
    for (let i = 0; i < 4; i++) rl.recordFailure("a");
    rl.recordSuccess("a");
    rl.recordFailure("a");
    expect(rl.retryAfter("a")).toBe(0);
    for (let i = 0; i < 5; i++) rl.recordFailure("b");
    expect(rl.retryAfter("b")).toBeGreaterThan(0);
    expect(rl.retryAfter("a")).toBe(0);
  });

  test("sweep removes stale entries", () => {
    let now = 0;
    const rl = new LoginRateLimiter({ now: () => now });
    rl.recordFailure("x");
    now += 16 * 60_000;
    rl.sweep();
    expect(rl.size).toBe(0);
  });
});
