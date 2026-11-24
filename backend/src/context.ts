import type { BotProfile } from "./bots.js";
import type { Instacart } from "./integrations/instacart.js";
import type { PriceProvider } from "./integrations/kroger.js";
import type { CareScope, Store, UserProfile } from "./store.js";
import type { FetchLike, Xai } from "./xai.js";

export interface Deps {
  store: Store;
  xai: Xai;
  bots: Map<string, BotProfile>;
  instacart: Instacart;
  prices: PriceProvider;
  fetch: FetchLike;
  now: () => Date;
  newId: () => string;
  /** Runs delegated tasks in the background. Tests can await it. */
  background: (work: Promise<unknown>) => void;
}

/** A request on behalf of a signed-in user, talking to one of their bots. */
export interface Ctx extends Deps {
  userId: string;
  profile: UserProfile;
  bot: BotProfile;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function profileFor(store: Store, userId: string): Promise<UserProfile> {
  return (await store.getProfile(userId)) ?? { userId, displayName: "friend", timezone: "America/New_York" };
}

/** Record an alert for the senior's caregivers (deduplicated by key). */
export async function raiseAlert(
  d: Pick<Deps, "store" | "now" | "newId">,
  seniorId: string,
  scope: CareScope,
  text: string,
  key: string,
  urgent = false,
): Promise<boolean> {
  return d.store.addAlert({ id: d.newId(), seniorId, scope, urgent, text, at: d.now().toISOString(), key });
}
