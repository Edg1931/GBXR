import { loadBots } from "../src/bots.js";
import type { Deps } from "../src/context.js";
import type { PriceProvider, PriceQuote } from "../src/integrations/kroger.js";
import { buildServer } from "../src/server.js";
import { MemoryStore } from "../src/store.js";
import type { Xai } from "../src/xai.js";

export class FakeXai implements Xai {
  vision: Record<string, unknown> = {};
  visionCalls: Array<{ schemaName: string; images: number }> = [];
  completion = "Here is your research brief.";
  async mintClientSecret() {
    return { value: "eph_secret", expiresAt: 1_900_000_000 };
  }
  async visionJson(o: { schemaName: string; imagesBase64: string[] }) {
    this.visionCalls.push({ schemaName: o.schemaName, images: o.imagesBase64.length });
    const v = this.vision[o.schemaName];
    if (v === undefined) throw new Error(`no fake vision response for ${o.schemaName}`);
    return v;
  }
  async complete() {
    return this.completion;
  }
}

export function setup(opts: { now?: string; quotes?: Record<string, PriceQuote | undefined> } = {}) {
  const store = new MemoryStore();
  const xai = new FakeXai();
  const pending: Promise<unknown>[] = [];
  let clock = new Date(opts.now ?? "2026-11-24T14:30:00Z"); // 08:30 in America/Chicago
  let id = 0;
  const instacartCalls: string[][] = [];
  const prices: PriceProvider = { quote: async (p) => opts.quotes?.[p] };
  const deps: Deps = {
    store,
    xai,
    bots: loadBots(),
    instacart: {
      createShoppingListLink: async (_t, items) => {
        instacartCalls.push(items);
        return "https://www.instacart.com/store/list/abc";
      },
    },
    prices,
    fetch: (async () => new Response("{}")) as typeof fetch,
    now: () => clock,
    newId: () => `id${++id}`,
    background: (w) => void pending.push(w),
  };
  const app = buildServer(deps, async (h) => {
    const m = h?.match(/^Bearer dev:(.+)$/);
    if (!m) throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
    return m[1]!;
  });
  const as = (user: string) => ({ authorization: `Bearer dev:${user}` });
  return {
    app,
    deps,
    store,
    xai,
    instacartCalls,
    as,
    setNow: (iso: string) => (clock = new Date(iso)),
    flush: () => Promise.all(pending),
  };
}

export const MEDS = [
  { id: "lisinopril", name: "Lisinopril", looks: "small white round pill", dose: "10 mg", times: ["08:00"] },
  { id: "metformin", name: "Metformin", looks: "large white oval pill", dose: "500 mg", times: ["08:00", "18:00"], withFood: true },
];

export const IMG = "aGVsbG8gd29ybGQgaGVsbG8gd29ybGQ=";
