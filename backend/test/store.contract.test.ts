import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgStore } from "../src/pgStore.js";
import { MemoryStore, type Store } from "../src/store.js";

/**
 * The same behavior contract for every Store. MemoryStore always runs;
 * PgStore runs when PG_TEST_URL points at a database with the migration
 * applied (CI and local runs do this; see test/pg-setup.sh).
 */
const PG = process.env.PG_TEST_URL;

const stores: Array<[string, () => Promise<{ store: Store; user: () => Promise<string>; done: () => Promise<void> }>]> = [
  ["MemoryStore", async () => ({ store: new MemoryStore(), user: async () => randomUUID(), done: async () => {} })],
];
if (PG) {
  stores.push([
    "PgStore",
    async () => {
      const admin = postgres(PG, { onnotice: () => {} });
      const store = new PgStore(PG);
      return {
        store,
        // Supabase users live in auth.users; create one per test user.
        user: async () => {
          const id = randomUUID();
          await admin`insert into auth.users (id) values (${id})`;
          return id;
        },
        done: async () => {
          await store.close();
          await admin.end();
        },
      };
    },
  ]);
}

describe.each(stores)("%s", (_name, make) => {
  let s: Store;
  let user: () => Promise<string>;
  let done: () => Promise<void>;
  beforeAll(async () => ({ store: s, user, done } = await make()));
  afterAll(async () => done());

  it("profiles and shares", async () => {
    const senior = await user();
    const kid = await user();
    await s.putProfile({ userId: senior, displayName: "Edna", timezone: "America/Chicago", latitude: 41.9, dietNotes: "low sodium" });
    await s.putProfile({ userId: senior, displayName: "Edna B", timezone: "America/Chicago", latitude: 41.9, dietNotes: "low sodium" });
    expect(await s.getProfile(senior)).toMatchObject({ displayName: "Edna B", latitude: 41.9, dietNotes: "low sodium" });
    expect((await s.listUsers()).some((p) => p.userId === senior)).toBe(true);

    await s.putShare({ seniorId: senior, caregiverId: kid, scopes: ["meds"] });
    await s.putShare({ seniorId: senior, caregiverId: kid, scopes: ["meds", "stories"] });
    expect((await s.getShare(senior, kid))?.scopes).toEqual(["meds", "stories"]);
    expect(await s.sharesForSenior(senior)).toHaveLength(1);
    expect((await s.sharesForCaregiver(kid))[0]?.seniorId).toBe(senior);
  });

  it("tasks keep mission links and update in place", async () => {
    const u = await user();
    const id = randomUUID();
    const mission = randomUUID();
    const t = { id, userId: u, botId: "nova", title: "Hotels", details: "", status: "queued" as const, missionId: mission, assignedBy: "chief", createdAt: "2026-11-24T10:00:00.000Z", updatedAt: "2026-11-24T10:00:00.000Z" };
    await s.putTask(t);
    await s.putTask({ ...t, status: "done", result: "3 options", updatedAt: "2026-11-24T10:01:00.000Z" });
    const [got] = await s.listTasks(u);
    expect(got).toMatchObject({ status: "done", result: "3 options", missionId: mission, assignedBy: "chief", createdAt: "2026-11-24T10:00:00.000Z" });
  });

  it("pantry, shopping list and price watches", async () => {
    const u = await user();
    expect(await s.latestPantry(u)).toBeUndefined();
    await s.putPantry({ userId: u, takenAt: "2026-11-24T10:00:00.000Z", items: [{ name: "egg", quantity: "2", freshness: "fresh" }] });
    await s.putPantry({ userId: u, takenAt: "2026-11-24T11:00:00.000Z", items: [{ name: "milk", quantity: "1", freshness: "use_soon" }] });
    expect((await s.latestPantry(u))?.items[0]?.name).toBe("milk");
    await s.setShoppingList(u, ["egg", "bread"]);
    expect(await s.getShoppingList(u)).toEqual(["egg", "bread"]);
    await s.putPriceWatch({ userId: u, product: "coffee" });
    await s.putPriceWatch({ userId: u, product: "coffee", lastPromo: 7.49 });
    expect(await s.listPriceWatches(u)).toEqual([{ userId: u, product: "coffee", lastPromo: 7.49 }]);
  });

  it("medications and dose logs (no duplicates)", async () => {
    const u = await user();
    await s.setMeds(u, [{ id: "a", name: "A", looks: "white", dose: "1", times: ["08:00", "20:00"], withFood: true, windowMinutes: 45 }]);
    await s.setMeds(u, [{ id: "b", name: "B", looks: "blue", dose: "2", times: ["09:00"], withFood: false, windowMinutes: 60 }]);
    expect(await s.getMeds(u)).toEqual([{ id: "b", name: "B", looks: "blue", dose: "2", times: ["09:00"], withFood: false, windowMinutes: 60 }]);
    const d = { userId: u, medicationId: "b", slot: "2026-11-24T09:00", takenAt: "2026-11-24T15:05:00.000Z" };
    await s.logDose(d);
    await s.logDose(d);
    expect(await s.doseLogs(u)).toEqual([d]);
  });

  it("sightings: latest wins, case-insensitive", async () => {
    const u = await user();
    await s.addSighting({ userId: u, object: "keys", location: "counter", seenAt: "2026-11-24T10:00:00.000Z", source: "camera" });
    await s.addSighting({ userId: u, object: "Keys", location: "blue bowl", seenAt: "2026-11-24T11:00:00.000Z", source: "told" });
    expect((await s.lastSighting(u, "KEYS"))?.location).toBe("blue bowl");
    expect(await s.lastSighting(u, "wallet")).toBeUndefined();
  });

  it("events, alerts (deduplicated), notifications (taken once), claims", async () => {
    const u = await user();
    await s.addEvent({ userId: u, at: "2026-11-24T10:00:00.000Z", scope: "meds", kind: "dose_taken", text: "Took A" });
    await s.addEvent({ userId: u, at: "2026-11-25T10:00:00.000Z", scope: "meds", kind: "dose_taken", text: "later" });
    expect((await s.events(u, "2026-11-24T00:00:00.000Z", "2026-11-25T00:00:00.000Z")).map((e) => e.text)).toEqual(["Took A"]);

    const key = `missed:${randomUUID()}`;
    const alert = { id: randomUUID(), seniorId: u, scope: "meds" as const, urgent: false, text: "missed", at: "2026-11-24T10:00:00.000Z", key };
    expect(await s.addAlert(alert)).toBe(true);
    expect(await s.addAlert({ ...alert, id: randomUUID() })).toBe(false);
    expect(await s.alertsForSenior(u)).toHaveLength(1);

    const taskId = randomUUID();
    await s.notify({ userId: u, botId: "nova", text: "one", at: "2026-11-24T10:00:00.000Z", taskId });
    await s.notify({ userId: u, botId: "pantry", text: "two", at: "2026-11-24T10:01:00.000Z" });
    const notes = await s.takeNotifications(u);
    expect(notes.map((n) => n.text)).toEqual(["one", "two"]);
    expect(notes[0]?.taskId).toBe(taskId);
    expect(await s.takeNotifications(u)).toEqual([]);

    const claim = `mission-reported:${randomUUID()}`;
    expect(await s.claimOnce(claim)).toBe(true);
    expect(await s.claimOnce(claim)).toBe(false);
  });
});
