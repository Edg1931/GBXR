import { randomUUID } from "node:crypto";
import { createAuthenticator } from "./auth.js";
import { loadBots } from "./bots.js";
import { loadConfig } from "./config.js";
import type { Deps } from "./context.js";
import { createInstacart } from "./integrations/instacart.js";
import { createKroger } from "./integrations/kroger.js";
import { checkMissedDoses, checkPriceWatches } from "./jobs.js";
import { buildServer } from "./server.js";
import { MemoryStore } from "./store.js";
import { createXai } from "./xai.js";

const cfg = loadConfig();
if (!cfg.xaiApiKey) console.warn("XAI_API_KEY is not set: voice sessions and camera checks will fail.");
if (!cfg.supabaseJwtSecret && !cfg.supabaseJwksUrl && !cfg.devAuth) {
  console.warn("No auth configured: set SUPABASE_JWKS_URL / SUPABASE_JWT_SECRET, or DEV_AUTH=1 for local testing.");
}

const deps: Deps = {
  // TODO: swap for a Supabase-backed Store (tables in supabase/migrations).
  store: new MemoryStore(),
  xai: createXai({ apiKey: cfg.xaiApiKey, baseUrl: cfg.xaiBaseUrl, visionModel: cfg.visionModel, taskModel: cfg.taskModel }),
  bots: loadBots(),
  instacart: createInstacart({ apiKey: cfg.instacartApiKey, baseUrl: cfg.instacartBaseUrl }),
  prices: createKroger({ clientId: cfg.krogerClientId, clientSecret: cfg.krogerClientSecret }),
  fetch,
  now: () => new Date(),
  newId: randomUUID,
  background: (work) => void work.catch((e) => console.error("background task failed", e)),
};

const app = buildServer(deps, createAuthenticator(cfg));

setInterval(() => void checkMissedDoses(deps).catch(console.error), 5 * 60_000);
setInterval(() => void checkPriceWatches(deps).catch(console.error), 12 * 60 * 60_000);

app.listen({ port: cfg.port, host: "0.0.0.0" }).then(() => {
  console.log(`GBXR backend on :${cfg.port} with ${deps.bots.size} bots`);
});
