import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Config } from "./config.js";
import { HttpError } from "./context.js";

export type Authenticator = (authorization: string | undefined) => Promise<string>;

/**
 * Verifies the app's session JWT (Supabase Auth: Google sign-in etc.) and
 * returns the user id (`sub`). Every user brings their own account; all data
 * is keyed by this id.
 */
export function createAuthenticator(cfg: Pick<Config, "supabaseJwtSecret" | "supabaseJwksUrl" | "devAuth">): Authenticator {
  const jwks = cfg.supabaseJwksUrl ? createRemoteJWKSet(new URL(cfg.supabaseJwksUrl)) : undefined;
  const secret = cfg.supabaseJwtSecret ? new TextEncoder().encode(cfg.supabaseJwtSecret) : undefined;

  async function verify(token: string): Promise<JWTPayload> {
    if (jwks) return (await jwtVerify(token, jwks)).payload;
    if (secret) return (await jwtVerify(token, secret)).payload;
    throw new Error("no auth configured");
  }

  return async (authorization) => {
    const token = authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) throw new HttpError(401, "missing bearer token");
    if (cfg.devAuth && token.startsWith("dev:")) return token.slice(4);
    let payload: JWTPayload;
    try {
      payload = await verify(token);
    } catch {
      throw new HttpError(401, "invalid token");
    }
    if (typeof payload.sub !== "string") throw new HttpError(401, "token has no subject");
    return payload.sub;
  };
}
