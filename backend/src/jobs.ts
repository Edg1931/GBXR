import { type Deps, raiseAlert } from "./context.js";
import { occurrences } from "./domain/meds.js";
import { localDateTime } from "./time.js";

/** Every few minutes: alert caregivers (with the "meds" scope) about missed doses. */
export async function checkMissedDoses(d: Deps): Promise<number> {
  let raised = 0;
  for (const user of await d.store.listUsers()) {
    const meds = await d.store.getMeds(user.userId);
    if (!meds.length) continue;
    const local = localDateTime(d.now(), user.timezone);
    for (const o of occurrences(meds, local, await d.store.doseLogs(user.userId))) {
      if (o.status !== "missed") continue;
      const created = await raiseAlert(
        d,
        user.userId,
        "meds",
        `${user.displayName} hasn't logged ${o.medication.name} (${o.slot.slice(11)} dose).`,
        `missed:${user.userId}:${o.medication.id}:${o.slot}`,
      );
      if (created) raised++;
    }
  }
  return raised;
}

/** Nightly: check watched products and let the grocery bot mention new sales. */
export async function checkPriceWatches(d: Deps, botId = "pantry"): Promise<number> {
  let found = 0;
  for (const user of await d.store.listUsers()) {
    if (!user.krogerLocationId) continue;
    for (const w of await d.store.listPriceWatches(user.userId)) {
      const q = await d.prices.quote(w.product, user.krogerLocationId).catch(() => undefined);
      if (!q) continue; // lookup failed: keep the last known state
      if (q.promo !== w.lastPromo) await d.store.putPriceWatch({ ...w, lastPromo: q.promo });
      if (q.promo !== undefined && q.promo !== w.lastPromo) {
        found++;
        await d.store.notify({
          userId: user.userId,
          botId,
          text: `${q.description} is on sale: $${q.promo.toFixed(2)} (usually $${q.regular.toFixed(2)}).`,
          at: d.now().toISOString(),
        });
      }
    }
  }
  return found;
}
