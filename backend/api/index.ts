import type { IncomingMessage, ServerResponse } from "node:http";
import { waitUntil } from "@vercel/functions";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

// Vercel function: every path is rewritten here (see vercel.json) and handed to Fastify.
// Delegated tasks keep running after the response via waitUntil.
const { app } = createApp(loadConfig(), (work) => waitUntil(work.catch((e) => console.error("background task failed", e))));
const ready = app.ready();

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await ready;
  app.server.emit("request", req, res);
}
