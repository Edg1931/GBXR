import type { PantryItem } from "../store.js";

export interface InventoryDiff {
  added: string[];
  removed: string[];
  useSoon: string[];
  expired: string[];
}

const norm = (s: string) => s.trim().toLowerCase().replace(/s$/, "");

export function diffInventory(previous: PantryItem[] | undefined, current: PantryItem[]): InventoryDiff {
  const prev = new Set((previous ?? []).map((i) => norm(i.name)));
  const cur = new Set(current.map((i) => norm(i.name)));
  return {
    added: previous ? current.filter((i) => !prev.has(norm(i.name))).map((i) => i.name) : [],
    removed: (previous ?? []).filter((i) => !cur.has(norm(i.name))).map((i) => i.name),
    useSoon: current.filter((i) => i.freshness === "use_soon").map((i) => i.name),
    expired: current.filter((i) => i.freshness === "expired").map((i) => i.name),
  };
}

/** Staples that, when they disappear from the fridge, go on the shopping list. */
export const STAPLES = ["milk", "egg", "butter", "bread", "cheese", "yogurt", "orange juice"];

export function missingStaples(diff: InventoryDiff): string[] {
  return diff.removed.filter((r) => STAPLES.some((s) => norm(r).includes(s)));
}
