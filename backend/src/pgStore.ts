import postgres from "postgres";
import type {
  Alert,
  CareEvent,
  CareScope,
  CareShare,
  DoseLog,
  Medication,
  Notification,
  PantryItem,
  PantrySnapshot,
  PriceWatch,
  Sighting,
  Store,
  Task,
  UserProfile,
} from "./store.js";

/**
 * Store backed by the Postgres schema in supabase/migrations. Connect with the
 * Supabase "transaction pooler" connection string (port 6543) on serverless
 * hosts; prepared statements are disabled for that reason.
 *
 * The backend authenticates every request itself and scopes every query by
 * user id; row-level security is the second line of defense for clients that
 * talk to Supabase directly.
 */
export class PgStore implements Store {
  private sql: postgres.Sql;

  constructor(url: string, opts: { max?: number } = {}) {
    this.sql = postgres(url, { prepare: false, max: opts.max ?? 5, idle_timeout: 20, onnotice: () => {} });
  }

  close() {
    return this.sql.end({ timeout: 5 });
  }

  private iso = (d: Date | string | null | undefined) => (d == null ? undefined : new Date(d).toISOString());
  private num = (n: unknown) => (n == null ? undefined : Number(n));
  private opt = <T>(v: T | null | undefined) => (v == null ? undefined : v);

  // ---- profiles

  async getProfile(userId: string) {
    const [r] = await this.sql`select * from profiles where user_id = ${userId}`;
    return r ? this.profile(r) : undefined;
  }

  async putProfile(p: UserProfile) {
    await this.sql`
      insert into profiles (user_id, display_name, timezone, latitude, longitude, diet_notes, kroger_location_id, updated_at)
      values (${p.userId}, ${p.displayName}, ${p.timezone}, ${p.latitude ?? null}, ${p.longitude ?? null},
              ${p.dietNotes ?? null}, ${p.krogerLocationId ?? null}, now())
      on conflict (user_id) do update set display_name = excluded.display_name, timezone = excluded.timezone,
        latitude = excluded.latitude, longitude = excluded.longitude, diet_notes = excluded.diet_notes,
        kroger_location_id = excluded.kroger_location_id, updated_at = now()`;
  }

  async listUsers() {
    return (await this.sql`select * from profiles`).map((r) => this.profile(r));
  }

  private profile(r: postgres.Row): UserProfile {
    return {
      userId: r.user_id,
      displayName: r.display_name,
      timezone: r.timezone,
      latitude: this.num(r.latitude),
      longitude: this.num(r.longitude),
      dietNotes: this.opt(r.diet_notes),
      krogerLocationId: this.opt(r.kroger_location_id),
    };
  }

  // ---- care shares

  async putShare(s: CareShare) {
    await this.sql`
      insert into care_shares (senior_id, caregiver_id, scopes)
      values (${s.seniorId}, ${s.caregiverId}, ${s.scopes}::care_scope[])
      on conflict (senior_id, caregiver_id) do update set scopes = excluded.scopes`;
  }

  async getShare(seniorId: string, caregiverId: string) {
    const [r] = await this.sql`select * from care_shares where senior_id = ${seniorId} and caregiver_id = ${caregiverId}`;
    return r ? this.share(r) : undefined;
  }

  async sharesForSenior(seniorId: string) {
    return (await this.sql`select * from care_shares where senior_id = ${seniorId}`).map((r) => this.share(r));
  }

  async sharesForCaregiver(caregiverId: string) {
    return (await this.sql`select * from care_shares where caregiver_id = ${caregiverId}`).map((r) => this.share(r));
  }

  private share(r: postgres.Row): CareShare {
    // care_scope[] arrives as a Postgres array literal string unless the type is registered.
    const scopes = Array.isArray(r.scopes) ? r.scopes : String(r.scopes).replace(/[{}]/g, "").split(",").filter(Boolean);
    return { seniorId: r.senior_id, caregiverId: r.caregiver_id, scopes: scopes as CareScope[] };
  }

  // ---- tasks

  async putTask(t: Task) {
    await this.sql`
      insert into tasks (id, user_id, bot_id, title, details, status, result, mission_id, assigned_by, created_at, updated_at)
      values (${t.id}, ${t.userId}, ${t.botId}, ${t.title}, ${t.details}, ${t.status}, ${t.result ?? null},
              ${t.missionId ?? null}, ${t.assignedBy ?? null}, ${t.createdAt}, ${t.updatedAt})
      on conflict (id) do update set status = excluded.status, result = excluded.result, updated_at = excluded.updated_at`;
  }

  async listTasks(userId: string) {
    const rows = await this.sql`select * from tasks where user_id = ${userId} order by created_at`;
    return rows.map(
      (r): Task => ({
        id: r.id,
        userId: r.user_id,
        botId: r.bot_id,
        title: r.title,
        details: r.details,
        status: r.status,
        result: this.opt(r.result),
        missionId: this.opt(r.mission_id),
        assignedBy: this.opt(r.assigned_by),
        createdAt: this.iso(r.created_at)!,
        updatedAt: this.iso(r.updated_at)!,
      }),
    );
  }

  // ---- pantry and shopping

  async latestPantry(userId: string) {
    const [r] = await this.sql`select * from pantry_snapshots where user_id = ${userId} order by taken_at desc, id desc limit 1`;
    return r ? ({ userId: r.user_id, takenAt: this.iso(r.taken_at)!, items: r.items as PantryItem[] } satisfies PantrySnapshot) : undefined;
  }

  async putPantry(s: PantrySnapshot) {
    await this.sql`insert into pantry_snapshots (user_id, taken_at, items) values (${s.userId}, ${s.takenAt}, ${this.sql.json(s.items as never)})`;
  }

  async getShoppingList(userId: string) {
    const [r] = await this.sql`select items from shopping_lists where user_id = ${userId}`;
    return (r?.items as string[] | undefined) ?? [];
  }

  async setShoppingList(userId: string, items: string[]) {
    await this.sql`
      insert into shopping_lists (user_id, items) values (${userId}, ${items})
      on conflict (user_id) do update set items = excluded.items`;
  }

  async listPriceWatches(userId: string) {
    const rows = await this.sql`select * from price_watches where user_id = ${userId}`;
    return rows.map((r): PriceWatch => ({ userId: r.user_id, product: r.product, lastPromo: this.num(r.last_promo) }));
  }

  async putPriceWatch(w: PriceWatch) {
    await this.sql`
      insert into price_watches (user_id, product, last_promo) values (${w.userId}, ${w.product}, ${w.lastPromo ?? null})
      on conflict (user_id, product) do update set last_promo = excluded.last_promo`;
  }

  // ---- medications

  async getMeds(userId: string) {
    const rows = await this.sql`select * from medications where user_id = ${userId} order by id`;
    return rows.map(
      (r): Medication => ({
        id: r.id,
        name: r.name,
        looks: r.looks,
        dose: r.dose,
        times: r.times,
        withFood: r.with_food,
        windowMinutes: r.window_minutes,
      }),
    );
  }

  async setMeds(userId: string, meds: Medication[]) {
    await this.sql.begin(async (tx) => {
      await tx`delete from medications where user_id = ${userId}`;
      for (const m of meds) {
        await tx`
          insert into medications (user_id, id, name, looks, dose, times, with_food, window_minutes)
          values (${userId}, ${m.id}, ${m.name}, ${m.looks}, ${m.dose}, ${m.times}, ${m.withFood ?? false}, ${m.windowMinutes ?? 60})`;
      }
    });
  }

  async logDose(d: DoseLog) {
    await this.sql`
      insert into dose_logs (user_id, medication_id, slot, taken_at) values (${d.userId}, ${d.medicationId}, ${d.slot}, ${d.takenAt})
      on conflict do nothing`;
  }

  async doseLogs(userId: string) {
    const rows = await this.sql`select * from dose_logs where user_id = ${userId}`;
    return rows.map((r): DoseLog => ({ userId: r.user_id, medicationId: r.medication_id, slot: r.slot, takenAt: this.iso(r.taken_at)! }));
  }

  // ---- object finder

  async addSighting(s: Sighting) {
    await this.sql`insert into sightings (user_id, object, location, seen_at, source) values (${s.userId}, ${s.object}, ${s.location}, ${s.seenAt}, ${s.source})`;
  }

  async lastSighting(userId: string, object: string) {
    const [r] = await this.sql`
      select * from sightings where user_id = ${userId} and lower(object) = lower(${object}) order by seen_at desc, id desc limit 1`;
    return r ? ({ userId: r.user_id, object: r.object, location: r.location, seenAt: this.iso(r.seen_at)!, source: r.source } satisfies Sighting) : undefined;
  }

  // ---- care timeline, alerts, notifications

  async addEvent(e: CareEvent) {
    await this.sql`insert into care_events (user_id, at, scope, kind, text) values (${e.userId}, ${e.at}, ${e.scope}, ${e.kind}, ${e.text})`;
  }

  async events(userId: string, fromIso: string, toIso: string) {
    const rows = await this.sql`
      select * from care_events where user_id = ${userId} and at >= ${fromIso} and at < ${toIso} order by at, id`;
    return rows.map((r): CareEvent => ({ userId: r.user_id, at: this.iso(r.at)!, scope: r.scope, kind: r.kind, text: r.text }));
  }

  async addAlert(a: Alert) {
    const rows = await this.sql`
      insert into alerts (id, senior_id, scope, urgent, text, at, key) values (${a.id}, ${a.seniorId}, ${a.scope}, ${a.urgent}, ${a.text}, ${a.at}, ${a.key})
      on conflict (key) do nothing returning id`;
    return rows.length > 0;
  }

  async alertsForSenior(seniorId: string) {
    const rows = await this.sql`select * from alerts where senior_id = ${seniorId} order by at`;
    return rows.map((r): Alert => ({ id: r.id, seniorId: r.senior_id, scope: r.scope, urgent: r.urgent, text: r.text, at: this.iso(r.at)!, key: r.key }));
  }

  async notify(n: Notification) {
    await this.sql`insert into notifications (user_id, bot_id, text, at, task_id) values (${n.userId}, ${n.botId}, ${n.text}, ${n.at}, ${n.taskId ?? null})`;
  }

  async claimOnce(key: string) {
    const rows = await this.sql`insert into claims (key) values (${key}) on conflict do nothing returning key`;
    return rows.length > 0;
  }

  /** Deletes and returns in one statement, so two devices never get the same notification. */
  async takeNotifications(userId: string) {
    const rows = await this.sql`delete from notifications where user_id = ${userId} returning *`;
    return rows
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((r): Notification => ({ userId: r.user_id, botId: r.bot_id, text: r.text, at: this.iso(r.at)!, taskId: this.opt(r.task_id) }));
  }
}
