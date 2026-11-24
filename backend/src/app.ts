import { randomUUID } from "node:crypto";
import { createAuthenticator } from "./auth.js";
import { loadBots } from "./bots.js";
import type { Config } from "./config.js";
import type { Deps } from "./context.js";
import { createInstacart } from "./integrations/instacart.js";
import { createKroger } from "./integrations/kroger.js";
import { PgStore } from "./pgStore.js";
import { buildServer } from "./server.js";
import { MemoryStore } from "./store.js";
import { createXai } from "./xai.js";

/** Builds the app the same way for a long-running server and for serverless hosts. */
export function createApp(cfg: Config, background: Deps["background"]) {
  const warn = (m: string) => console.warn(`[gbxr] ${m}`);
  if (!cfg.xaiApiKey) warn("XAI_API_KEY is not set: voice sessions and camera checks will fail.");
  if (!cfg.supabaseJwtSecret && !cfg.supabaseJwksUrl && !cfg.devAuth) warn("No auth configured (SUPABASE_JWKS_URL or SUPABASE_JWT_SECRET).");
  if (!cfg.databaseUrl) warn("DATABASE_URL is not set: using the in-memory store (data is lost on restart).");

  const deps: Deps = {
    store: cfg.databaseUrl ? new PgStore(cfg.databaseUrl) : new MemoryStore(),
    xai: createXai({ apiKey: cfg.xaiApiKey, baseUrl: cfg.xaiBaseUrl, visionModel: cfg.visionModel, taskModel: cfg.taskModel }),
    bots: loadBots(),
    instacart: createInstacart({ apiKey: cfg.instacartApiKey, baseUrl: cfg.instacartBaseUrl }),
    prices: createKroger({ clientId: cfg.krogerClientId, clientSecret: cfg.krogerClientSecret }),
    fetch,
    now: () => new Date(),
    newId: randomUUID,
    background,
  };
  return { deps, app: buildServer(deps, createAuthenticator(cfg), { cronSecret: cfg.cronSecret }) };
}
