import { z } from "zod";
import { type Ctx, raiseAlert } from "./context.js";
import { diffInventory, missingStaples } from "./domain/inventory.js";
import { occurrences } from "./domain/meds.js";
import { combineRisk, heuristicFlags } from "./domain/scam.js";
import { localDateTime } from "./time.js";

export type Priority = "low" | "normal" | "urgent";

export interface PerceptionResult {
  /** Fact brief the bot turns into speech in its own voice; null = stay quiet. */
  say: string | null;
  priority: Priority;
  data: unknown;
}

const SYSTEM =
  "You analyze photos taken by a home assistant's smart glasses. Report only what you can actually see. " +
  "If something is unclear, say so instead of guessing. Respond with JSON matching the schema.";

// ---------- Fridge ----------

const fridgeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "quantity", "freshness"],
        properties: {
          name: { type: "string", description: "Common name, singular, e.g. 'egg', 'spinach'" },
          quantity: { type: "string", description: "e.g. 'half carton', '2', 'almost empty'" },
          freshness: { type: "string", enum: ["fresh", "use_soon", "expired", "unknown"] },
        },
      },
    },
  },
} as const;

const FridgeOut = z.object({
  items: z.array(z.object({ name: z.string(), quantity: z.string(), freshness: z.enum(["fresh", "use_soon", "expired", "unknown"]) })),
});

async function fridge(ctx: Ctx, images: string[]): Promise<PerceptionResult> {
  const out = FridgeOut.parse(
    await ctx.xai.visionJson({
      system: SYSTEM,
      prompt:
        "List the food and drink visible in this refrigerator. Judge freshness from visible cues only " +
        "(wilting, mold, discoloration, nearly empty containers). Use 'unknown' when you can't tell.",
      imagesBase64: images,
      schemaName: "fridge_inventory",
      schema: fridgeSchema,
    }),
  );
  const previous = await ctx.store.latestPantry(ctx.userId);
  const diff = diffInventory(previous?.items, out.items);
  const now = ctx.now().toISOString();
  await ctx.store.putPantry({ userId: ctx.userId, takenAt: now, items: out.items });

  const missing = missingStaples(diff);
  if (missing.length) {
    const list = await ctx.store.getShoppingList(ctx.userId);
    await ctx.store.setShoppingList(ctx.userId, [...new Set([...list, ...missing])]);
  }

  const watches = await ctx.store.listPriceWatches(ctx.userId);
  const onSale = watches.filter(
    (w) => w.lastPromo !== undefined && missing.some((m) => m.toLowerCase().includes(w.product.toLowerCase())),
  );

  await ctx.store.addEvent({
    userId: ctx.userId,
    at: now,
    scope: "meals",
    kind: "fridge_check",
    text: `Fridge checked: ${out.items.length} items${diff.expired.length ? `, expired: ${diff.expired.join(", ")}` : ""}`,
  });

  const lines: string[] = [];
  if (diff.expired.length) lines.push(`These look spoiled and should be thrown out: ${diff.expired.join(", ")}.`);
  if (diff.useSoon.length) lines.push(`Use soon: ${diff.useSoon.join(", ")}. Offer one simple meal idea using them${ctx.profile.dietNotes ? ` that fits their diet (${ctx.profile.dietNotes})` : ""}.`);
  if (missing.length) lines.push(`They're out of ${missing.join(", ")} — it's been added to the shopping list.`);
  for (const w of onSale) lines.push(`${w.product} is on sale right now for $${w.lastPromo!.toFixed(2)}.`);
  if (out.items.length <= 3) lines.push("The fridge looks nearly empty. Ask if they'd like help ordering groceries.");

  const priority: Priority = diff.expired.length ? "normal" : "low";
  return { say: lines.length ? lines.join(" ") : null, priority, data: { items: out.items, diff, addedToList: missing } };
}

// ---------- Pills ----------

const pillsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["pills"],
  properties: {
    pills: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "count"],
        properties: {
          description: { type: "string", description: "Color, shape, size, markings, e.g. 'small white round pill'" },
          count: { type: "integer" },
        },
      },
    },
  },
} as const;
const PillsOut = z.object({ pills: z.array(z.object({ description: z.string(), count: z.number() })) });

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]+/g) ?? []);
function similarity(a: string, b: string) {
  const A = words(a);
  const B = words(b);
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / Math.max(1, Math.min(A.size, B.size));
}

async function pills(ctx: Ctx, images: string[]): Promise<PerceptionResult> {
  const out = PillsOut.parse(
    await ctx.xai.visionJson({
      system: SYSTEM,
      prompt: "Describe each distinct pill visible (in a hand, organizer compartment or on a table): color, shape, size, markings, and how many.",
      imagesBase64: images,
      schemaName: "pills_seen",
      schema: pillsSchema,
    }),
  );
  const meds = await ctx.store.getMeds(ctx.userId);
  const matches = out.pills.map((p) => {
    const best = meds
      .map((m) => ({ m, score: similarity(p.description, m.looks) }))
      .sort((a, b) => b.score - a.score)[0];
    return { seen: p.description, count: p.count, medication: best && best.score >= 0.6 ? best.m : undefined };
  });

  const localNow = localDateTime(ctx.now(), ctx.profile.timezone);
  const due = occurrences(meds, localNow, await ctx.store.doseLogs(ctx.userId)).filter((o) => o.status === "due");

  const lines: string[] = [];
  for (const m of matches) {
    if (m.medication) lines.push(`The ${m.seen} looks like their ${m.medication.name} (${m.medication.dose}).`);
    else lines.push(`You don't recognize the ${m.seen}. Say so plainly and suggest checking the bottle label or asking the pharmacist before taking it.`);
  }
  if (due.length) lines.push(`Due now: ${due.map((d) => d.medication.name).join(", ")}. Ask them to confirm out loud once they've taken it, then log it.`);
  // We never mark a dose as taken from a photo alone; the person confirms.
  return { say: lines.length ? lines.join(" ") : null, priority: "normal", data: { matches, due: due.map((d) => d.slot) } };
}

// ---------- Mail / scam guard ----------

const mailSchema = {
  type: "object",
  additionalProperties: false,
  required: ["documentType", "sender", "summary", "text", "scamRisk", "redFlags", "suggestedAction"],
  properties: {
    documentType: { type: "string", description: "letter, bill, flyer, check, notice, other" },
    sender: { type: "string" },
    summary: { type: "string", description: "One plain-language sentence" },
    text: { type: "string", description: "Key text transcribed from the document" },
    scamRisk: { type: "string", enum: ["low", "medium", "high"] },
    redFlags: { type: "array", items: { type: "string" } },
    suggestedAction: { type: "string" },
  },
} as const;
const MailOut = z.object({
  documentType: z.string(),
  sender: z.string(),
  summary: z.string(),
  text: z.string(),
  scamRisk: z.enum(["low", "medium", "high"]),
  redFlags: z.array(z.string()),
  suggestedAction: z.string(),
});

async function mail(ctx: Ctx, images: string[]): Promise<PerceptionResult> {
  const out = MailOut.parse(
    await ctx.xai.visionJson({
      system: SYSTEM,
      prompt:
        "Read this piece of mail for an older adult. Explain what it is and assess whether it may be a scam " +
        "(urgency, threats, prizes, requests for gift cards/wire/crypto or personal numbers, mismatched sender details).",
      imagesBase64: images,
      schemaName: "mail_review",
      schema: mailSchema,
    }),
  );
  const flags = [...new Set([...out.redFlags, ...heuristicFlags(`${out.text} ${out.summary}`)])];
  const risk = combineRisk(out.scamRisk, flags);
  const now = ctx.now().toISOString();

  if (risk === "high") {
    await ctx.store.addEvent({ userId: ctx.userId, at: now, scope: "safety", kind: "scam_flag", text: `Possible scam mail from ${out.sender}: ${out.summary}` });
    await raiseAlert(ctx, ctx.userId, "safety", `Possible scam mail from "${out.sender}": ${out.summary} (${flags.join("; ")})`, `scam:${ctx.userId}:${out.sender}:${now.slice(0, 10)}`);
  }

  const say =
    risk === "high"
      ? `This looks like a scam. It's ${out.summary} Warning signs: ${flags.join("; ")}. Tell them not to call any number on it or send money, and offer to send it to their family.`
      : risk === "medium"
        ? `It's ${out.summary} A few things look off: ${flags.join("; ")}. Suggest double-checking with family or calling the company using a number they already trust.`
        : `It's ${out.summary} ${out.suggestedAction}`;
  return { say, priority: risk === "high" ? "urgent" : "normal", data: { ...out, redFlags: flags, scamRisk: risk } };
}

// ---------- Object finder ----------

export const TRACKED_OBJECTS = ["keys", "glasses", "wallet", "phone", "remote", "hearing aids", "purse", "cane"];

const objectsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["objects"],
  properties: {
    objects: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["object", "location"],
        properties: {
          object: { type: "string", enum: TRACKED_OBJECTS },
          location: { type: "string", description: "Where it is, e.g. 'on the kitchen counter next to the fruit bowl'" },
        },
      },
    },
  },
} as const;
const ObjectsOut = z.object({ objects: z.array(z.object({ object: z.string(), location: z.string() })) });

async function objects(ctx: Ctx, images: string[]): Promise<PerceptionResult> {
  const out = ObjectsOut.parse(
    await ctx.xai.visionJson({
      system: SYSTEM,
      prompt: `Which of these everyday objects are visible, and exactly where: ${TRACKED_OBJECTS.join(", ")}? Only list ones you can clearly see.`,
      imagesBase64: images,
      schemaName: "objects_seen",
      schema: objectsSchema,
    }),
  );
  const at = ctx.now().toISOString();
  for (const o of out.objects) await ctx.store.addSighting({ userId: ctx.userId, object: o.object, location: o.location, seenAt: at, source: "camera" });
  // Silent: the finder only speaks when asked "where are my keys?".
  return { say: null, priority: "low", data: out };
}

const handlers = { fridge, pills, mail, objects } as const;
export type PerceptionKind = keyof typeof handlers;
export const PERCEPTION_KINDS = Object.keys(handlers) as PerceptionKind[];

export function perceive(ctx: Ctx, kind: PerceptionKind, images: string[]) {
  return handlers[kind](ctx, images);
}
