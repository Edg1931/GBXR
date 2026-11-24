import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { checkMissedDoses, checkPriceWatches } from "./jobs.js";

// Long-running server (local dev, Docker, Render, Fly...). On Vercel, api/index.ts is used instead.
const cfg = loadConfig();
const { deps, app } = createApp(cfg, (work) => void work.catch((e) => console.error("background task failed", e)));

setInterval(() => void checkMissedDoses(deps).catch(console.error), 5 * 60_000);
setInterval(() => void checkPriceWatches(deps).catch(console.error), 12 * 60 * 60_000);

app.listen({ port: cfg.port, host: "0.0.0.0" }).then(() => {
  console.log(`GBXR backend on :${cfg.port} with ${deps.bots.size} bots`);
});
