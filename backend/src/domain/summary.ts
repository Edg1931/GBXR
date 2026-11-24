import type { CareScope, Store, UserProfile } from "../store.js";
import { localDateTime } from "../time.js";
import { occurrences } from "./meds.js";

export interface DailySummary {
  seniorId: string;
  date: string;
  scopes: CareScope[];
  meds?: { taken: string[]; missed: string[]; upcoming: string[] };
  timeline: Array<{ at: string; scope: CareScope; text: string }>;
  /** Plain sentence built from facts only (no AI wording, so nothing is invented). */
  headline: string;
}

/**
 * The caregiver's daily view, limited to what the senior agreed to share.
 * `now` decides which doses count as missed vs upcoming.
 */
export async function dailySummary(store: Store, senior: UserProfile, scopes: CareScope[], now: Date): Promise<DailySummary> {
  const localNow = localDateTime(now, senior.timezone);
  const date = localNow.slice(0, 10);
  // Events are stored in UTC; widen the window, then filter by the senior's local date.
  const from = new Date(now.getTime() - 2 * 86_400_000).toISOString();
  const to = new Date(now.getTime() + 86_400_000).toISOString();
  const events = (await store.events(senior.userId, from, to))
    .filter((e) => scopes.includes(e.scope) && localDateTime(new Date(e.at), senior.timezone).startsWith(date))
    .map((e) => ({ at: localDateTime(new Date(e.at), senior.timezone).slice(11), scope: e.scope, text: e.text }));

  const summary: DailySummary = { seniorId: senior.userId, date, scopes, timeline: events, headline: "" };
  const parts: string[] = [];
  if (scopes.includes("meds")) {
    const occ = occurrences(await store.getMeds(senior.userId), localNow, await store.doseLogs(senior.userId));
    const label = (o: (typeof occ)[number]) => `${o.medication.name} ${o.slot.slice(11)}`;
    summary.meds = {
      taken: occ.filter((o) => o.status === "taken").map(label),
      missed: occ.filter((o) => o.status === "missed").map(label),
      upcoming: occ.filter((o) => o.status === "upcoming" || o.status === "due").map(label),
    };
    parts.push(`Medicines: ${summary.meds.taken.length} taken, ${summary.meds.missed.length} missed`);
  }
  const count = (s: CareScope) => events.filter((e) => e.scope === s).length;
  if (scopes.includes("meals")) parts.push(`${count("meals")} fridge checks`);
  if (scopes.includes("activity")) parts.push(`${count("activity")} exercise sessions`);
  if (scopes.includes("stories") && count("stories")) parts.push(`${count("stories")} new stories saved`);
  if (scopes.includes("safety") && count("safety")) parts.push(`${count("safety")} safety flags`);
  summary.headline = `${senior.displayName}, ${date}: ${parts.join(", ") || "nothing shared yet"}.`;
  return summary;
}
