import { z } from "zod";
import { type Ctx, HttpError, raiseAlert } from "./context.js";
import { occurrences } from "./domain/meds.js";
import { currentWeather } from "./integrations/weather.js";
import type { Task } from "./store.js";
import { localDateTime } from "./time.js";

/**
 * Tools the voice model can call. Each has a JSON schema (sent to the realtime
 * session) and an executor. A bot may only call tools listed in its profile;
 * that is enforced here, not just in the prompt.
 */
interface ToolDef<A extends z.ZodTypeAny> {
  description: string;
  args: A;
  parameters: object;
  run(ctx: Ctx, args: z.infer<A>): Promise<unknown>;
}

const obj = (properties: Record<string, object>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const str = (description: string) => ({ type: "string", description });

function tool<A extends z.ZodTypeAny>(def: ToolDef<A>) {
  return def;
}

async function runTask(ctx: Ctx, task: Task) {
  const save = (patch: Partial<Task>) => ctx.store.putTask({ ...task, ...patch, updatedAt: ctx.now().toISOString() });
  try {
    await save({ status: "running" });
    const result = await ctx.xai.complete({
      system: `${ctx.bot.instructions}\nYou are completing a delegated task. Produce a concise, well-organized result the bot can read aloud in under a minute, followed by details.`,
      prompt: `Task: ${task.title}\n\nDetails: ${task.details}`,
    });
    Object.assign(task, { status: "done", result });
    await save({ status: "done", result });
    await ctx.store.notify({ userId: ctx.userId, botId: ctx.bot.id, text: `Task finished: ${task.title}`, at: ctx.now().toISOString(), taskId: task.id });
  } catch (e) {
    await save({ status: "failed", result: e instanceof Error ? e.message : String(e) });
  }
}

export const TOOLS = {
  create_task: tool({
    description: "Delegate a piece of work to run in the background (research, drafting, planning). The bot reports back when it's done.",
    args: z.object({ title: z.string().min(1), details: z.string().default("") }),
    parameters: obj({ title: str("Short task name"), details: str("Everything needed to do it well") }, ["title"]),
    async run(ctx, a) {
      const now = ctx.now().toISOString();
      const task: Task = { id: ctx.newId(), userId: ctx.userId, botId: ctx.bot.id, title: a.title, details: a.details, status: "queued", createdAt: now, updatedAt: now };
      await ctx.store.putTask(task);
      ctx.background(runTask(ctx, task));
      return { taskId: task.id, status: "queued" };
    },
  }),

  list_tasks: tool({
    description: "List the user's recent tasks and their status.",
    args: z.object({}),
    parameters: obj({}),
    async run(ctx) {
      const tasks = (await ctx.store.listTasks(ctx.userId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10);
      return tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, result: t.result?.slice(0, 1500) }));
    },
  }),

  get_pantry: tool({
    description: "What was in the fridge at the last check, and the current shopping list.",
    args: z.object({}),
    parameters: obj({}),
    async run(ctx) {
      const snap = await ctx.store.latestPantry(ctx.userId);
      return { checkedAt: snap?.takenAt ?? null, items: snap?.items ?? [], shoppingList: await ctx.store.getShoppingList(ctx.userId) };
    },
  }),

  add_to_shopping_list: tool({
    description: "Add items to the shopping list.",
    args: z.object({ items: z.array(z.string().min(1)).min(1) }),
    parameters: obj({ items: { type: "array", items: { type: "string" } } }, ["items"]),
    async run(ctx, a) {
      const list = [...new Set([...(await ctx.store.getShoppingList(ctx.userId)), ...a.items])];
      await ctx.store.setShoppingList(ctx.userId, list);
      return { shoppingList: list };
    },
  }),

  create_instacart_link: tool({
    description: "Turn the shopping list into an Instacart checkout link and send it to the user's phone.",
    args: z.object({}),
    parameters: obj({}),
    async run(ctx) {
      const items = await ctx.store.getShoppingList(ctx.userId);
      if (!items.length) return { error: "The shopping list is empty." };
      const url = await ctx.instacart.createShoppingListLink(`${ctx.profile.displayName}'s groceries`, items);
      await ctx.store.notify({ userId: ctx.userId, botId: ctx.bot.id, text: `Your grocery list is ready to order: ${url}`, at: ctx.now().toISOString() });
      return { sentToPhone: true, url };
    },
  }),

  watch_price: tool({
    description: "Watch a product's price and tell the user when it goes on sale.",
    args: z.object({ product: z.string().min(1) }),
    parameters: obj({ product: str("e.g. 'eggs', 'Folgers coffee'") }, ["product"]),
    async run(ctx, a) {
      await ctx.store.putPriceWatch({ userId: ctx.userId, product: a.product });
      return { watching: a.product, store: ctx.profile.krogerLocationId ? "set" : "not set — ask a family member to pick a store in the app" };
    },
  }),

  get_med_schedule: tool({
    description: "Today's medicines with status (upcoming, due, taken, missed).",
    args: z.object({}),
    parameters: obj({}),
    async run(ctx) {
      const local = localDateTime(ctx.now(), ctx.profile.timezone);
      const occ = occurrences(await ctx.store.getMeds(ctx.userId), local, await ctx.store.doseLogs(ctx.userId));
      return occ.map((o) => ({ medicationId: o.medication.id, name: o.medication.name, dose: o.medication.dose, looks: o.medication.looks, time: o.slot.slice(11), status: o.status, withFood: !!o.medication.withFood }));
    },
  }),

  log_dose: tool({
    description: "Record that the person says they took a medicine. Only call after they confirm.",
    args: z.object({ medicationId: z.string(), time: z.string().regex(/^\d{2}:\d{2}$/).optional() }),
    parameters: obj({ medicationId: str("From get_med_schedule"), time: str("Scheduled time HH:mm; omit for the dose due now") }, ["medicationId"]),
    async run(ctx, a) {
      const local = localDateTime(ctx.now(), ctx.profile.timezone);
      const occ = occurrences(await ctx.store.getMeds(ctx.userId), local, await ctx.store.doseLogs(ctx.userId)).filter((o) => o.medication.id === a.medicationId);
      if (!occ.length) throw new HttpError(404, "unknown medication");
      const target = a.time
        ? occ.find((o) => o.slot.endsWith(a.time!))
        : (occ.find((o) => o.status === "due") ?? occ.filter((o) => o.status === "missed").at(-1));
      if (!target) return { logged: false, reason: "No dose is due right now for that medicine." };
      if (target.status === "taken") return { logged: false, reason: "That dose was already logged. Do not take it again." };
      await ctx.store.logDose({ userId: ctx.userId, medicationId: a.medicationId, slot: target.slot, takenAt: ctx.now().toISOString() });
      await ctx.store.addEvent({ userId: ctx.userId, at: ctx.now().toISOString(), scope: "meds", kind: "dose_taken", text: `Took ${target.medication.name} (${target.slot.slice(11)} dose)` });
      return { logged: true, slot: target.slot };
    },
  }),

  remember_object_location: tool({
    description: "Remember where the person says they put something.",
    args: z.object({ object: z.string().min(1), location: z.string().min(1) }),
    parameters: obj({ object: str("e.g. 'keys'"), location: str("e.g. 'blue bowl by the door'") }, ["object", "location"]),
    async run(ctx, a) {
      await ctx.store.addSighting({ userId: ctx.userId, object: a.object, location: a.location, seenAt: ctx.now().toISOString(), source: "told" });
      return { remembered: true };
    },
  }),

  where_is: tool({
    description: "Where an object was last seen or put.",
    args: z.object({ object: z.string().min(1) }),
    parameters: obj({ object: str("e.g. 'glasses'") }, ["object"]),
    async run(ctx, a) {
      const s = await ctx.store.lastSighting(ctx.userId, a.object);
      if (!s) return { known: false };
      return { known: true, location: s.location, lastSeenLocalTime: localDateTime(new Date(s.seenAt), ctx.profile.timezone), how: s.source === "camera" ? "seen" : "told" };
    },
  }),

  message_caregiver: tool({
    description: "Send a message to the person's family/caregivers. Use urgent=true only for safety concerns.",
    args: z.object({ message: z.string().min(1), urgent: z.boolean().default(false) }),
    parameters: obj({ message: str("What to tell them"), urgent: { type: "boolean" } }, ["message"]),
    async run(ctx, a) {
      const scope = a.urgent ? "safety" : "messages";
      await raiseAlert(ctx, ctx.userId, scope, `${ctx.bot.name}: ${a.message}`, `msg:${ctx.newId()}`, a.urgent);
      await ctx.store.addEvent({ userId: ctx.userId, at: ctx.now().toISOString(), scope, kind: "caregiver_message", text: a.message });
      const caregivers = (await ctx.store.sharesForSenior(ctx.userId)).filter((s) => s.scopes.includes(scope));
      return { delivered: caregivers.length > 0, recipients: caregivers.length };
    },
  }),

  save_story: tool({
    description: "Save a life story the person told, for their family. Only after they agree.",
    args: z.object({ title: z.string().min(1), summary: z.string().min(1) }),
    parameters: obj({ title: str("Short title"), summary: str("The story in their words, a few paragraphs") }, ["title", "summary"]),
    async run(ctx, a) {
      await ctx.store.addEvent({ userId: ctx.userId, at: ctx.now().toISOString(), scope: "stories", kind: "story", text: `${a.title}: ${a.summary}` });
      return { saved: true };
    },
  }),

  log_exercise: tool({
    description: "Record a finished exercise session.",
    args: z.object({ routine: z.string().min(1), minutes: z.number().min(0).max(240) }),
    parameters: obj({ routine: str("What they did"), minutes: { type: "number" } }, ["routine", "minutes"]),
    async run(ctx, a) {
      await ctx.store.addEvent({ userId: ctx.userId, at: ctx.now().toISOString(), scope: "activity", kind: "exercise", text: `${a.routine} (${a.minutes} min)` });
      return { logged: true };
    },
  }),

  get_weather: tool({
    description: "Current weather at home.",
    args: z.object({}),
    parameters: obj({}),
    async run(ctx) {
      const { latitude, longitude } = ctx.profile;
      if (latitude === undefined || longitude === undefined) return { error: "Home location not set." };
      return currentWeather(latitude, longitude, ctx.fetch);
    },
  }),
} satisfies Record<string, ToolDef<any>>;

export type ToolName = keyof typeof TOOLS;

/** Realtime-session tool definitions for one bot. */
export function toolSchemasFor(botTools: string[]) {
  return botTools
    .filter((n): n is ToolName => n in TOOLS)
    .map((name) => ({ type: "function", name, description: TOOLS[name].description, parameters: TOOLS[name].parameters }));
}

export async function runTool(ctx: Ctx, name: string, rawArgs: unknown) {
  if (!(name in TOOLS)) throw new HttpError(404, `unknown tool ${name}`);
  if (!ctx.bot.tools.includes(name)) throw new HttpError(403, `${ctx.bot.name} is not allowed to use ${name}`);
  const def = TOOLS[name as ToolName] as ToolDef<z.ZodTypeAny>;
  const parsed = def.args.safeParse(rawArgs ?? {});
  if (!parsed.success) throw new HttpError(400, `bad arguments for ${name}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  return def.run(ctx, parsed.data);
}
