import { jwtVerify, SignJWT } from "jose";
import type { Env } from "../../config/env";

export const JWT_ISSUER = "mafaaza-api";
export const JWT_AUDIENCE = "mafaaza-dashboard";

export function sha256Hex(input: string): string {
  return new Bun.CryptoHasher("sha256").update(input).digest("hex");
}

/** 32 random bytes, base64url (43 chars). Only its SHA-256 is stored. */
export function generateRefreshToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

export interface AccessClaims {
  sub: string;
  /** password version: admin.password_changed_at in ms at issuance */
  pwv: number;
}

export async function signAccessToken(
  env: Env,
  claims: AccessClaims,
  now: Date,
): Promise<{ token: string; expiresAt: Date }> {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + env.ACCESS_TOKEN_TTL_SECONDS;
  const token = await new SignJWT({ pwv: claims.pwv })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(claims.sub)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(crypto.randomUUID())
    .sign(new TextEncoder().encode(env.JWT_SECRET));
  return { token, expiresAt: new Date(exp * 1000) };
}

export async function verifyAccessToken(env: Env, token: string, now: Date): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(env.JWT_SECRET), {
      algorithms: ["HS256"],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      currentDate: now,
    });
    if (typeof payload.sub !== "string" || typeof payload.pwv !== "number") return null;
    return { sub: payload.sub, pwv: payload.pwv };
  } catch {
    return null;
  }
}
