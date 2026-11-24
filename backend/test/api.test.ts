import { describe, expect, it } from "vitest";
import { diffInventory } from "../src/domain/inventory.js";
import { combineRisk, heuristicFlags } from "../src/domain/scam.js";
import { checkMissedDoses, checkPriceWatches } from "../src/jobs.js";
import { localDateTime } from "../src/time.js";
import { IMG, MEDS, setup } from "./helpers.js";

const senior = { displayName: "Edna", timezone: "America/Chicago", dietNotes: "low sodium" };

async function seedSenior(t: ReturnType<typeof setup>) {
  await t.app.inject({ method: "PUT", url: "/v1/profile", headers: t.as("edna"), payload: senior });
  await t.app.inject({ method: "PUT", url: "/v1/meds", headers: t.as("edna"), payload: MEDS });
}

const tool = (t: ReturnType<typeof setup>, user: string, botId: string, name: string, args: unknown = {}) =>
  t.app.inject({ method: "POST", url: `/v1/tools/${name}`, headers: t.as(user), payload: { botId, args } });

describe("accounts and voice sessions", () => {
  it("requires sign-in", async () => {
    const t = setup();
    const r = await t.app.inject({ method: "POST", url: "/v1/voice/session", payload: { botId: "pantry" } });
    expect(r.statusCode).toBe(401);
  });

  it("mints a short-lived secret and a session with only the bot's tools", async () => {
    const t = setup();
    await seedSenior(t);
    const r = await t.app.inject({ method: "POST", url: "/v1/voice/session", headers: t.as("edna"), payload: { botId: "pillpal" } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.clientSecret).toBe("eph_secret");
    expect(body.session.voice).toBe("ara");
    expect(body.session.instructions).toContain("Edna");
    expect(body.session.tools.map((x: { name: string }) => x.name).sort()).toEqual(["get_med_schedule", "log_dose", "message_caregiver"]);
  });

  it("does not expose system prompts in the bot list", async () => {
    const t = setup();
    const bots = (await t.app.inject({ url: "/v1/bots", headers: t.as("u") })).json();
    expect(bots.length).toBeGreaterThanOrEqual(8);
    expect(bots[0].instructions).toBeUndefined();
  });

  it("blocks a bot from tools it doesn't have", async () => {
    const t = setup();
    const r = await tool(t, "edna", "mailguard", "log_dose", { medicationId: "metformin" });
    expect(r.statusCode).toBe(403);
  });

  it("keeps each user's data separate", async () => {
    const t = setup();
    await tool(t, "alice", "finder", "remember_object_location", { object: "keys", location: "blue bowl" });
    const bob = (await tool(t, "bob", "finder", "where_is", { object: "keys" })).json();
    expect(bob.known).toBe(false);
    const alice = (await tool(t, "alice", "finder", "where_is", { object: "Keys" })).json();
    expect(alice.location).toBe("blue bowl");
  });
});

describe("fridge bot", () => {
  it("tracks inventory, flags food to use, adds missing staples, mentions sales", async () => {
    const t = setup();
    await seedSenior(t);
    t.xai.vision.fridge_inventory = {
      items: [
        { name: "milk", quantity: "half", freshness: "fresh" },
        { name: "egg", quantity: "2", freshness: "fresh" },
        { name: "spinach", quantity: "half bag", freshness: "fresh" },
        { name: "chicken", quantity: "1 pack", freshness: "fresh" },
      ],
    };
    const first = await t.app.inject({ method: "POST", url: "/v1/perception", headers: t.as("edna"), payload: { botId: "pantry", kind: "fridge", images: [IMG] } });
    expect(first.statusCode).toBe(200);

    await t.store.putPriceWatch({ userId: "edna", product: "egg", lastPromo: 2.49 });
    t.xai.vision.fridge_inventory = {
      items: [
        { name: "milk", quantity: "almost empty", freshness: "fresh" },
        { name: "spinach", quantity: "half bag", freshness: "use_soon" },
        { name: "chicken", quantity: "1 pack", freshness: "fresh" },
        { name: "yogurt", quantity: "1", freshness: "expired" },
      ],
    };
    const r = (await t.app.inject({ method: "POST", url: "/v1/perception", headers: t.as("edna"), payload: { botId: "pantry", kind: "fridge", images: [IMG, IMG] } })).json();
    expect(r.priority).toBe("normal");
    expect(r.say).toContain("yogurt");
    expect(r.say).toContain("spinach");
    expect(r.say).toContain("low sodium");
    expect(r.say).toContain("out of egg");
    expect(r.say).toContain("on sale");
    expect(await t.store.getShoppingList("edna")).toEqual(["egg"]);
    expect(t.xai.visionCalls.at(-1)).toEqual({ schemaName: "fridge_inventory", images: 2 });

    const link = (await tool(t, "edna", "pantry", "create_instacart_link")).json();
    expect(link.sentToPhone).toBe(true);
    expect(t.instacartCalls).toEqual([["egg"]]);
    const notes = (await t.app.inject({ url: "/v1/notifications", headers: t.as("edna") })).json();
    expect(notes[0].text).toContain("instacart.com");
  });

  it("only lets a bot use its own camera check", async () => {
    const t = setup();
    const r = await t.app.inject({ method: "POST", url: "/v1/perception", headers: t.as("edna"), payload: { botId: "pantry", kind: "mail", images: [IMG] } });
    expect(r.statusCode).toBe(403);
  });

  it("diffs inventory with simple plural matching", () => {
    const d = diffInventory([{ name: "Eggs", quantity: "6", freshness: "fresh" }], [{ name: "egg", quantity: "1", freshness: "use_soon" }]);
    expect(d.removed).toEqual([]);
    expect(d.useSoon).toEqual(["egg"]);
  });
});

describe("medication bot and caregiver alerts", () => {
  it("logs a confirmed dose, refuses doubles, and alerts only caregivers with the meds scope", async () => {
    const t = setup(); // 08:30 Chicago
    await seedSenior(t);
    await t.app.inject({ method: "PUT", url: "/v1/care/shares", headers: t.as("edna"), payload: { caregiverId: "daughter", scopes: ["meds", "meals"] } });
    await t.app.inject({ method: "PUT", url: "/v1/care/shares", headers: t.as("edna"), payload: { caregiverId: "neighbor", scopes: ["safety"] } });

    const sched = (await tool(t, "edna", "pillpal", "get_med_schedule")).json();
    expect(sched.filter((s: { status: string }) => s.status === "due").length).toBe(2);

    expect((await tool(t, "edna", "pillpal", "log_dose", { medicationId: "lisinopril" })).json().logged).toBe(true);
    const again = (await tool(t, "edna", "pillpal", "log_dose", { medicationId: "lisinopril", time: "08:00" })).json();
    expect(again.logged).toBe(false);
    expect(again.reason).toContain("already");

    t.setNow("2026-11-24T15:30:00Z"); // 09:30: metformin 08:00 window passed
    expect(await checkMissedDoses(t.deps)).toBe(1);
    expect(await checkMissedDoses(t.deps)).toBe(0); // deduplicated

    const daughterAlerts = (await t.app.inject({ url: "/v1/care/edna/alerts", headers: t.as("daughter") })).json();
    expect(daughterAlerts).toHaveLength(1);
    expect(daughterAlerts[0].text).toContain("Metformin");
    const neighborAlerts = (await t.app.inject({ url: "/v1/care/edna/alerts", headers: t.as("neighbor") })).json();
    expect(neighborAlerts).toHaveLength(0);

    const summary = (await t.app.inject({ url: "/v1/care/edna/summary", headers: t.as("daughter") })).json();
    expect(summary.meds.taken).toEqual(["Lisinopril 08:00"]);
    expect(summary.meds.missed).toEqual(["Metformin 08:00"]);
    expect(summary.headline).toContain("Edna");

    const stranger = await t.app.inject({ url: "/v1/care/edna/summary", headers: t.as("stranger") });
    expect(stranger.statusCode).toBe(403);
  });

  it("matches pills seen to the person's medicines and never auto-logs", async () => {
    const t = setup();
    await seedSenior(t);
    t.xai.vision.pills_seen = { pills: [{ description: "large white oval pill", count: 1 }, { description: "tiny pink capsule", count: 1 }] };
    const r = (await t.app.inject({ method: "POST", url: "/v1/perception", headers: t.as("edna"), payload: { botId: "pillpal", kind: "pills", images: [IMG] } })).json();
    expect(r.say).toContain("Metformin");
    expect(r.say).toContain("don't recognize the tiny pink capsule");
    expect(await t.store.doseLogs("edna")).toHaveLength(0);
  });
});

describe("scam guard", () => {
  it("escalates a likely scam even if the model is unsure, and alerts the safety contact", async () => {
    const t = setup();
    await seedSenior(t);
    await t.app.inject({ method: "PUT", url: "/v1/care/shares", headers: t.as("edna"), payload: { caregiverId: "son", scopes: ["safety"] } });
    t.xai.vision.mail_review = {
      documentType: "letter",
      sender: "Medicare Benefits Dept",
      summary: "a letter saying your Medicare will be suspended unless you pay.",
      text: "FINAL NOTICE. Your benefits will be suspended. Pay within 24 hours using gift cards.",
      scamRisk: "medium",
      redFlags: [],
      suggestedAction: "",
    };
    const r = (await t.app.inject({ method: "POST", url: "/v1/perception", headers: t.as("edna"), payload: { botId: "mailguard", kind: "mail", images: [IMG] } })).json();
    expect(r.priority).toBe("urgent");
    expect(r.data.scamRisk).toBe("high");
    expect(r.say).toContain("scam");
    const alerts = (await t.app.inject({ url: "/v1/care/edna/alerts", headers: t.as("son") })).json();
    expect(alerts[0].scope).toBe("safety");
  });

  it("heuristics", () => {
    expect(heuristicFlags("Pay with Google Play gift cards immediately")).toHaveLength(2);
    expect(combineRisk("high", [])).toBe("high");
    expect(combineRisk("low", ["x"])).toBe("medium");
  });
});

describe("delegation and companions", () => {
  it("runs a delegated task in the background and notifies when done", async () => {
    const t = setup();
    const r = (await tool(t, "me", "nova", "create_task", { title: "Compare AR glasses", details: "price, weight, battery" })).json();
    expect(r.status).toBe("queued");
    await t.flush();
    const tasks = (await t.app.inject({ url: "/v1/tasks", headers: t.as("me") })).json();
    expect(tasks[0].status).toBe("done");
    expect(tasks[0].result).toContain("research brief");
    const notes = (await t.app.inject({ url: "/v1/notifications", headers: t.as("me") })).json();
    expect(notes[0]).toMatchObject({ botId: "nova", text: "Task finished: Compare AR glasses", taskId: r.taskId });
  });

  it("shares stories with family only when the stories scope is granted", async () => {
    const t = setup();
    await seedSenior(t);
    await tool(t, "edna", "storykeeper", "save_story", { title: "Meeting Frank", summary: "We met at a dance in 1962." });
    await t.app.inject({ method: "PUT", url: "/v1/care/shares", headers: t.as("edna"), payload: { caregiverId: "daughter", scopes: ["meds"] } });
    let s = (await t.app.inject({ url: "/v1/care/edna/summary", headers: t.as("daughter") })).json();
    expect(s.timeline).toHaveLength(0);
    await t.app.inject({ method: "PUT", url: "/v1/care/shares", headers: t.as("edna"), payload: { caregiverId: "daughter", scopes: ["meds", "stories"] } });
    s = (await t.app.inject({ url: "/v1/care/edna/summary", headers: t.as("daughter") })).json();
    expect(s.timeline[0].text).toContain("Meeting Frank");
  });
});

describe("price watch job", () => {
  it("announces a new sale once", async () => {
    const t = setup({ quotes: { coffee: { product: "coffee", description: "Folgers Classic Roast", regular: 9.99, promo: 7.49 } } });
    await t.store.putProfile({ userId: "edna", displayName: "Edna", timezone: "America/Chicago", krogerLocationId: "01400943" });
    await tool(t, "edna", "pantry", "watch_price", { product: "coffee" });
    expect(await checkPriceWatches(t.deps)).toBe(1);
    expect(await checkPriceWatches(t.deps)).toBe(0);
    const notes = await t.store.takeNotifications("edna");
    expect(notes[0]!.text).toContain("$7.49");
  });
});

describe("time", () => {
  it("formats local time in a zone", () => {
    expect(localDateTime(new Date("2026-11-24T14:30:00Z"), "America/Chicago")).toBe("2026-11-24T08:30");
  });
});
