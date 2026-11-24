import type { DoseLog, Medication } from "../store.js";
import { addMinutes } from "../time.js";

export type DoseStatus = "upcoming" | "due" | "taken" | "missed";

export interface Occurrence {
  medication: Medication;
  /** Local "YYYY-MM-DDTHH:mm". */
  slot: string;
  status: DoseStatus;
}

/** Mirrors core/care/MedicationSchedule.kt so phone, glasses and server agree. */
export function occurrences(meds: Medication[], localNow: string, logs: DoseLog[]): Occurrence[] {
  const date = localNow.slice(0, 10);
  const taken = new Set(logs.map((l) => `${l.medicationId}@${l.slot}`));
  return meds
    .flatMap((m) =>
      m.times.map((t) => {
        const slot = `${date}T${t}`;
        const end = addMinutes(slot, m.windowMinutes ?? 60);
        const status: DoseStatus = taken.has(`${m.id}@${slot}`)
          ? "taken"
          : localNow < slot
            ? "upcoming"
            : localNow < end
              ? "due"
              : "missed";
        return { medication: m, slot, status };
      }),
    )
    .sort((a, b) => a.slot.localeCompare(b.slot));
}
