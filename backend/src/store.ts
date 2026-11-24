/**
 * Storage interface. MemoryStore is used in tests and local development; the
 * production implementation maps 1:1 onto the Supabase tables in
 * supabase/migrations (every row is owned by a user id, enforced by RLS).
 */

export type CareScope = "meds" | "meals" | "activity" | "stories" | "safety" | "mood" | "messages";
export const CARE_SCOPES: CareScope[] = ["meds", "meals", "activity", "stories", "safety", "mood", "messages"];

export interface UserProfile {
  userId: string;
  displayName: string;
  /** IANA zone, e.g. "America/Chicago". */
  timezone: string;
  latitude?: number;
  longitude?: number;
  dietNotes?: string;
  /** Kroger store id for price checks. */
  krogerLocationId?: string;
}

export interface CareShare {
  seniorId: string;
  caregiverId: string;
  scopes: CareScope[];
}

export interface Task {
  id: string;
  userId: string;
  botId: string;
  title: string;
  details: string;
  status: "queued" | "running" | "done" | "failed";
  result?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PantryItem {
  name: string;
  quantity: string;
  freshness: "fresh" | "use_soon" | "expired" | "unknown";
}

export interface PantrySnapshot {
  userId: string;
  takenAt: string;
  items: PantryItem[];
}

export interface Medication {
  id: string;
  name: string;
  looks: string;
  dose: string;
  times: string[];
  withFood?: boolean;
  windowMinutes?: number;
}

export interface DoseLog {
  userId: string;
  medicationId: string;
  /** Local scheduled slot, "YYYY-MM-DDTHH:mm". */
  slot: string;
  takenAt: string;
}

export interface Sighting {
  userId: string;
  object: string;
  location: string;
  seenAt: string;
  source: "camera" | "told";
}

export interface PriceWatch {
  userId: string;
  product: string;
  lastPromo?: number;
}

/** Timeline of notable things, used for the caregiver summary. */
export interface CareEvent {
  userId: string;
  at: string;
  scope: CareScope;
  kind: string;
  text: string;
}

export interface Alert {
  id: string;
  seniorId: string;
  scope: CareScope;
  urgent: boolean;
  text: string;
  at: string;
  /** Dedup key so a job can't raise the same alert twice. */
  key: string;
}

export interface Notification {
  userId: string;
  botId: string;
  text: string;
  at: string;
  /** Set when this reports a finished delegated task. */
  taskId?: string;
}

export interface Store {
  getProfile(userId: string): Promise<UserProfile | undefined>;
  putProfile(p: UserProfile): Promise<void>;
  listUsers(): Promise<UserProfile[]>;

  putShare(s: CareShare): Promise<void>;
  getShare(seniorId: string, caregiverId: string): Promise<CareShare | undefined>;
  sharesForSenior(seniorId: string): Promise<CareShare[]>;
  sharesForCaregiver(caregiverId: string): Promise<CareShare[]>;

  putTask(t: Task): Promise<void>;
  listTasks(userId: string): Promise<Task[]>;

  latestPantry(userId: string): Promise<PantrySnapshot | undefined>;
  putPantry(s: PantrySnapshot): Promise<void>;
  getShoppingList(userId: string): Promise<string[]>;
  setShoppingList(userId: string, items: string[]): Promise<void>;
  listPriceWatches(userId: string): Promise<PriceWatch[]>;
  putPriceWatch(w: PriceWatch): Promise<void>;

  getMeds(userId: string): Promise<Medication[]>;
  setMeds(userId: string, meds: Medication[]): Promise<void>;
  logDose(d: DoseLog): Promise<void>;
  doseLogs(userId: string): Promise<DoseLog[]>;

  addSighting(s: Sighting): Promise<void>;
  lastSighting(userId: string, object: string): Promise<Sighting | undefined>;

  addEvent(e: CareEvent): Promise<void>;
  events(userId: string, fromIso: string, toIso: string): Promise<CareEvent[]>;

  /** Returns false if an alert with the same key already exists. */
  addAlert(a: Alert): Promise<boolean>;
  alertsForSenior(seniorId: string): Promise<Alert[]>;

  notify(n: Notification): Promise<void>;
  takeNotifications(userId: string): Promise<Notification[]>;
}

export class MemoryStore implements Store {
  profiles = new Map<string, UserProfile>();
  shares: CareShare[] = [];
  tasks: Task[] = [];
  pantry: PantrySnapshot[] = [];
  shopping = new Map<string, string[]>();
  watches: PriceWatch[] = [];
  meds = new Map<string, Medication[]>();
  doses: DoseLog[] = [];
  sightings: Sighting[] = [];
  careEvents: CareEvent[] = [];
  alerts: Alert[] = [];
  notifications: Notification[] = [];

  async getProfile(id: string) { return this.profiles.get(id); }
  async putProfile(p: UserProfile) { this.profiles.set(p.userId, p); }
  async listUsers() { return [...this.profiles.values()]; }

  async putShare(s: CareShare) {
    this.shares = this.shares.filter((x) => !(x.seniorId === s.seniorId && x.caregiverId === s.caregiverId));
    this.shares.push(s);
  }
  async getShare(seniorId: string, caregiverId: string) {
    return this.shares.find((s) => s.seniorId === seniorId && s.caregiverId === caregiverId);
  }
  async sharesForSenior(seniorId: string) { return this.shares.filter((s) => s.seniorId === seniorId); }
  async sharesForCaregiver(caregiverId: string) { return this.shares.filter((s) => s.caregiverId === caregiverId); }

  async putTask(t: Task) {
    this.tasks = this.tasks.filter((x) => x.id !== t.id);
    this.tasks.push(t);
  }
  async listTasks(userId: string) { return this.tasks.filter((t) => t.userId === userId); }

  async latestPantry(userId: string) {
    return this.pantry.filter((p) => p.userId === userId).at(-1);
  }
  async putPantry(s: PantrySnapshot) { this.pantry.push(s); }
  async getShoppingList(userId: string) { return this.shopping.get(userId) ?? []; }
  async setShoppingList(userId: string, items: string[]) { this.shopping.set(userId, items); }
  async listPriceWatches(userId: string) { return this.watches.filter((w) => w.userId === userId); }
  async putPriceWatch(w: PriceWatch) {
    this.watches = this.watches.filter((x) => !(x.userId === w.userId && x.product === w.product));
    this.watches.push(w);
  }

  async getMeds(userId: string) { return this.meds.get(userId) ?? []; }
  async setMeds(userId: string, meds: Medication[]) { this.meds.set(userId, meds); }
  async logDose(d: DoseLog) {
    if (!this.doses.some((x) => x.userId === d.userId && x.medicationId === d.medicationId && x.slot === d.slot)) {
      this.doses.push(d);
    }
  }
  async doseLogs(userId: string) { return this.doses.filter((d) => d.userId === userId); }

  async addSighting(s: Sighting) { this.sightings.push(s); }
  async lastSighting(userId: string, object: string) {
    const o = object.toLowerCase();
    return this.sightings.filter((s) => s.userId === userId && s.object.toLowerCase() === o).at(-1);
  }

  async addEvent(e: CareEvent) { this.careEvents.push(e); }
  async events(userId: string, fromIso: string, toIso: string) {
    return this.careEvents.filter((e) => e.userId === userId && e.at >= fromIso && e.at < toIso);
  }

  async addAlert(a: Alert) {
    if (this.alerts.some((x) => x.key === a.key)) return false;
    this.alerts.push(a);
    return true;
  }
  async alertsForSenior(seniorId: string) { return this.alerts.filter((a) => a.seniorId === seniorId); }

  async notify(n: Notification) { this.notifications.push(n); }
  async takeNotifications(userId: string) {
    const mine = this.notifications.filter((n) => n.userId === userId);
    this.notifications = this.notifications.filter((n) => n.userId !== userId);
    return mine;
  }
}
