import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const Trigger = z.discriminatedUnion("type", [
  z.object({ type: z.literal("gaze") }).passthrough(),
  z.object({ type: z.literal("schedule"), times: z.array(z.string().regex(/^\d{2}:\d{2}$/)) }).passthrough(),
]);

export const BotProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/),
  name: z.string(),
  role: z.string(),
  voice: z.string(),
  personality: z.string(),
  instructions: z.string(),
  avatar: z.string(),
  audience: z.enum(["general", "senior"]).default("general"),
  tools: z.array(z.string()).default([]),
  idleBehaviors: z.array(z.string()).default([]),
  placement: z
    .object({
      anchorLabel: z.string(),
      triggers: z.array(Trigger),
      perception: z.enum(["none", "fridge", "pills", "mail", "objects", "exercise"]).default("none"),
      cooldownSeconds: z.number().default(300),
    })
    .optional(),
});
export type BotProfile = z.infer<typeof BotProfileSchema>;

const defaultDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bots");

export function loadBots(dir = defaultDir): Map<string, BotProfile> {
  const bots = new Map<string, BotProfile>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const bot = BotProfileSchema.parse(JSON.parse(readFileSync(join(dir, file), "utf8")));
    if (`${bot.id}.json` !== file) throw new Error(`${file}: id "${bot.id}" must match the file name`);
    bots.set(bot.id, bot);
  }
  return bots;
}
