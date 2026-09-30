import { Elysia } from "elysia";
import type { AdminProfile, AuthService } from "../modules/auth/service";

/**
 * Adds the `auth` macro. Routes declared with `auth: true` (or inside `.guard({ auth: true })`)
 * require a valid access token and receive `admin` in their context.
 *
 * Authentication runs in `transform` — before body/query validation — so an unauthenticated
 * caller always gets 401 and never learns the request schema from a 422.
 */
export function authPlugin(service: AuthService) {
  const verified = new WeakMap<Request, AdminProfile>();
  return new Elysia({ name: "auth-plugin", seed: service.instanceId }).macro({
    auth: {
      async transform({ request, headers }) {
        verified.set(request, await service.authenticate(headers.authorization));
      },
      async resolve({ request, headers }) {
        const admin: AdminProfile = verified.get(request) ?? (await service.authenticate(headers.authorization));
        return { admin };
      },
    },
  });
}

export type AuthPlugin = ReturnType<typeof authPlugin>;
