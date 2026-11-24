import Fastify, { type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import type { Authenticator } from "./auth.js";
import type { BotProfile } from "./bots.js";
import { type Ctx, type Deps, HttpError, profileFor } from "./context.js";
import { dailySummary } from "./domain/summary.js";
import { PERCEPTION_KINDS, perceive, type PerceptionKind } from "./perception.js";
import { CARE_SCOPES, type CareScope } from "./store.js";
import { runTool, toolSchemasFor } from "./tools.js";
import { XaiError } from "./xai.js";

const BotRef = z.object({ botId: z.string() });

export function buildServer(deps: Deps, authenticate: Authenticator) {
  // Camera frames arrive as base64 JPEGs; allow a few per request.
  const app = Fastify({ bodyLimit: 12 * 1024 * 1024, logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof ZodError) return reply.status(400).send({ error: "invalid request", issues: err.issues });
    if (err instanceof XaiError) return reply.status(502).send({ error: "AI service error" });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message });
    console.error(err);
    return reply.status(500).send({ error: "internal error" });
  });

  const userId = (req: FastifyRequest) => authenticate(req.headers.authorization);

  const botFor = (id: string): BotProfile => {
    const bot = deps.bots.get(id);
    if (!bot) throw new HttpError(404, `unknown bot ${id}`);
    return bot;
  };

  async function ctxFor(req: FastifyRequest, botId: string): Promise<Ctx> {
    const uid = await userId(req);
    return { ...deps, userId: uid, profile: await profileFor(deps.store, uid), bot: botFor(botId) };
  }

  /** Caregiver access: only what the senior chose to share. */
  async function caregiverScopes(req: FastifyRequest, seniorId: string): Promise<CareScope[]> {
    const uid = await userId(req);
    if (uid === seniorId) return CARE_SCOPES; // seniors can always see their own data
    const share = await deps.store.getShare(seniorId, uid);
    if (!share || !share.scopes.length) throw new HttpError(403, "not shared with you");
    return share.scopes;
  }

  app.get("/health", async () => ({ ok: true }));

  app.get("/v1/bots", async (req) => {
    await userId(req);
    return [...deps.bots.values()].map(({ instructions: _i, ...publicFields }) => publicFields);
  });

  app.put("/v1/profile", async (req) => {
    const uid = await userId(req);
    const body = z
      .object({
        displayName: z.string().min(1),
        timezone: z.string().refine((tz) => {
          try {
            new Intl.DateTimeFormat("en", { timeZone: tz });
            return true;
          } catch {
            return false;
          }
        }, "unknown timezone"),
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
        dietNotes: z.string().max(500).optional(),
        krogerLocationId: z.string().optional(),
      })
      .parse(req.body);
    const profile = { userId: uid, ...body };
    await deps.store.putProfile(profile);
    return profile;
  });

  const Med = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    looks: z.string().min(1),
    dose: z.string().min(1),
    times: z.array(z.string().regex(/^\d{2}:\d{2}$/)).min(1),
    withFood: z.boolean().optional(),
    windowMinutes: z.number().int().min(10).max(240).optional(),
  });

  app.get("/v1/meds", async (req) => deps.store.getMeds(await userId(req)));
  app.put("/v1/meds", async (req) => {
    const uid = await userId(req);
    const meds = z.array(Med).parse(req.body);
    await deps.store.setMeds(uid, meds);
    return meds;
  });

  // Mints a short-lived xAI secret so the headset talks to xAI directly (low
  // latency) without ever holding the API key.
  app.post("/v1/voice/session", async (req) => {
    const { botId } = BotRef.parse(req.body);
    const ctx = await ctxFor(req, botId);
    const secret = await deps.xai.mintClientSecret();
    const about = [`The person you're helping is ${ctx.profile.displayName}.`];
    if (ctx.profile.dietNotes) about.push(`Diet notes: ${ctx.profile.dietNotes}.`);
    return {
      clientSecret: secret.value,
      expiresAt: secret.expiresAt,
      session: {
        voice: ctx.bot.voice,
        instructions: `${ctx.bot.instructions}\n\nPersonality: ${ctx.bot.personality}\n${about.join(" ")}`,
        turn_detection: { type: "server_vad" },
        tools: toolSchemasFor(ctx.bot.tools),
      },
    };
  });

  app.post("/v1/perception", async (req) => {
    const body = BotRef.extend({
      kind: z.enum(PERCEPTION_KINDS as [PerceptionKind, ...PerceptionKind[]]),
      images: z.array(z.string().min(16)).min(1).max(4),
    }).parse(req.body);
    const ctx = await ctxFor(req, body.botId);
    if (ctx.bot.placement?.perception !== body.kind) {
      throw new HttpError(403, `${ctx.bot.name} does not use the ${body.kind} camera check`);
    }
    return perceive(ctx, body.kind, body.images);
  });

  app.post<{ Params: { name: string } }>("/v1/tools/:name", async (req) => {
    const body = BotRef.extend({ args: z.unknown().optional() }).parse(req.body);
    const ctx = await ctxFor(req, body.botId);
    return runTool(ctx, req.params.name, body.args);
  });

  app.get("/v1/tasks", async (req) => {
    const tasks = await deps.store.listTasks(await userId(req));
    return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });

  /** The app polls this; bots speak these (sale alerts, finished tasks, links). */
  app.get("/v1/notifications", async (req) => deps.store.takeNotifications(await userId(req)));

  // ---- Family / caregiver access ----

  app.put("/v1/care/shares", async (req) => {
    const seniorId = await userId(req);
    const body = z
      .object({ caregiverId: z.string().min(1), scopes: z.array(z.enum(CARE_SCOPES as [CareScope, ...CareScope[]])) })
      .parse(req.body);
    if (body.caregiverId === seniorId) throw new HttpError(400, "cannot share with yourself");
    const share = { seniorId, caregiverId: body.caregiverId, scopes: [...new Set(body.scopes)] };
    await deps.store.putShare(share);
    return share;
  });

  app.get("/v1/care/shares", async (req) => {
    const uid = await userId(req);
    return { sharedByMe: await deps.store.sharesForSenior(uid), sharedWithMe: await deps.store.sharesForCaregiver(uid) };
  });

  app.get<{ Params: { seniorId: string } }>("/v1/care/:seniorId/summary", async (req) => {
    const scopes = await caregiverScopes(req, req.params.seniorId);
    const senior = await deps.store.getProfile(req.params.seniorId);
    if (!senior) throw new HttpError(404, "no profile");
    return dailySummary(deps.store, senior, scopes, deps.now());
  });

  app.get<{ Params: { seniorId: string } }>("/v1/care/:seniorId/alerts", async (req) => {
    const scopes = await caregiverScopes(req, req.params.seniorId);
    return (await deps.store.alertsForSenior(req.params.seniorId))
      .filter((a) => scopes.includes(a.scope))
      .sort((a, b) => b.at.localeCompare(a.at));
  });

  return app;
}
