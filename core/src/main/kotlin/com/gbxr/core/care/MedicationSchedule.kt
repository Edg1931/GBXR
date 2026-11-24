package com.gbxr.core.care

import kotlinx.serialization.Serializable
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime

/**
 * On-device medication reminders. These must work offline, so the schedule
 * logic lives here; the backend keeps the authoritative log and sends
 * caregiver alerts.
 *
 * This is a reminder and logging aid, not a medical device.
 */
@Serializable
data class Medication(
    val id: String,
    val name: String,
    /** How it looks, so the bot can say "the small white round one". */
    val looks: String,
    val dose: String,
    /** Local times, "HH:mm". */
    val times: List<String>,
    val withFood: Boolean = false,
    /** How long after the scheduled time a dose still counts as on time. */
    val windowMinutes: Int = 60,
)

@Serializable
data class DoseLog(val medicationId: String, val slot: String, val takenAt: String)

enum class DoseStatus { UPCOMING, DUE, TAKEN, MISSED }

data class DoseOccurrence(
    val medication: Medication,
    /** Local date-time of the scheduled dose. */
    val scheduled: LocalDateTime,
    val status: DoseStatus,
) {
    /** Stable key used in logs: "<medId>@2026-11-24T08:00". */
    val slotKey: String get() = "${medication.id}@$scheduled"
}

class MedicationSchedule(private val medications: List<Medication>) {

    fun occurrencesOn(date: LocalDate, now: LocalDateTime, logs: List<DoseLog>): List<DoseOccurrence> {
        val taken = logs.map { "${it.medicationId}@${it.slot}" }.toSet()
        return medications.flatMap { med ->
            med.times.map { t ->
                val scheduled = LocalDateTime.of(date, LocalTime.parse(t))
                val key = "${med.id}@$scheduled"
                val windowEnd = scheduled.plusMinutes(med.windowMinutes.toLong())
                val status = when {
                    key in taken -> DoseStatus.TAKEN
                    now.isBefore(scheduled) -> DoseStatus.UPCOMING
                    now.isBefore(windowEnd) -> DoseStatus.DUE
                    else -> DoseStatus.MISSED
                }
                DoseOccurrence(med, scheduled, status)
            }
        }.sortedBy { it.scheduled }
    }

    fun dueNow(now: LocalDateTime, logs: List<DoseLog>): List<DoseOccurrence> =
        occurrencesOn(now.toLocalDate(), now, logs).filter { it.status == DoseStatus.DUE }

    /**
     * What the pill-box bot says when it wakes. Kept short and concrete,
     * one thing at a time, which works better for older adults.
     */
    fun reminderLine(due: List<DoseOccurrence>): String? {
        if (due.isEmpty()) return null
        val parts = due.map { "${it.medication.name}, ${it.medication.dose} — the ${it.medication.looks}" }
        val food = if (due.any { it.medication.withFood }) " Please take it with some food." else ""
        return if (parts.size == 1) "It's time for your ${parts[0]}.$food"
        else "It's time for ${parts.size} medicines: ${parts.joinToString("; ")}.$food"
    }
}
