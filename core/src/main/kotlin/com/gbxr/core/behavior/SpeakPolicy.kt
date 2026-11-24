package com.gbxr.core.behavior

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.time.LocalTime

@Serializable
enum class Priority {
    @SerialName("low") LOW,
    @SerialName("normal") NORMAL,
    @SerialName("urgent") URGENT,
}

/**
 * Bots should talk when it's useful, not every time you glance at the fridge.
 * Urgent things (missed meds, likely scam) always get through; low-priority
 * chatter (recipe ideas, sale alerts) is rate-limited and muted at night.
 */
class SpeakPolicy(
    private val quietStart: LocalTime = LocalTime.of(21, 30),
    private val quietEnd: LocalTime = LocalTime.of(7, 30),
    private val maxLowPerHour: Int = 2,
) {
    private val lowSpokenAt = ArrayDeque<Long>()

    fun shouldSpeak(priority: Priority, localTime: LocalTime, elapsedMillis: Long): Boolean {
        if (priority == Priority.URGENT) return true
        if (isQuiet(localTime)) return false
        if (priority == Priority.NORMAL) return true

        val hourAgo = elapsedMillis - 3_600_000
        while (lowSpokenAt.isNotEmpty() && lowSpokenAt.first() <= hourAgo) lowSpokenAt.removeFirst()
        if (lowSpokenAt.size >= maxLowPerHour) return false
        lowSpokenAt.addLast(elapsedMillis)
        return true
    }

    fun isQuiet(t: LocalTime): Boolean =
        if (quietStart <= quietEnd) !t.isBefore(quietStart) && t.isBefore(quietEnd)
        else !t.isBefore(quietStart) || t.isBefore(quietEnd)
}
