package com.gbxr.core.place

import com.gbxr.core.model.BotProfile
import com.gbxr.core.model.TriggerSpec
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import kotlin.math.acos
import kotlin.math.sqrt

data class Vec3(val x: Float, val y: Float, val z: Float) {
    operator fun minus(o: Vec3) = Vec3(x - o.x, y - o.y, z - o.z)
    fun length() = sqrt(x * x + y * y + z * z)
    fun dot(o: Vec3) = x * o.x + y * o.y + z * o.z
}

/**
 * One tick of what the device knows. The XR layer builds this from head pose,
 * persisted anchors and a cheap scene-change score (frame difference); the
 * engine itself has no Android dependency so it can be unit tested.
 */
data class SensorFrame(
    val now: LocalDateTime,
    val elapsedMillis: Long,
    val headPosition: Vec3,
    /** Unit vector of where the wearer is looking. */
    val gazeDirection: Vec3,
    /** Anchor id -> world position, for anchors currently tracked. */
    val anchors: Map<String, Vec3>,
    /** 0 = view unchanged, 1 = completely different (e.g. fridge door opened). */
    val sceneChange: Float = 0f,
    /** Whether the glasses/headset are being worn (Android XR Device Availability). */
    val worn: Boolean = true,
)

enum class WakeReason { GAZE, SCHEDULE }

/** Where a wake should be delivered: in the headset, or on the phone/tablet fallback. */
enum class Delivery { HEADSET, COMPANION_DEVICE }

data class WakeEvent(
    val botId: String,
    val anchorId: String?,
    val reason: WakeReason,
    val delivery: Delivery,
    /** For schedule wakes: the "HH:mm" slot that fired. */
    val slot: String? = null,
)

/**
 * Decides when place bots wake up. Register each bot with the anchor the user
 * placed it on, then feed [SensorFrame]s; it returns wake events, respecting
 * dwell time, scene-change requirements and per-bot cooldowns.
 */
class PlaceBotEngine {
    private class Registration(val bot: BotProfile, val anchorId: String) {
        var gazeStartMillis: Long? = null
        var sawSceneChange = false
        var lastGazeWakeMillis: Long? = null
        val firedSlots = mutableSetOf<String>() // "2026-11-24T08:00"
    }

    private val registrations = mutableMapOf<String, Registration>()

    fun register(bot: BotProfile, anchorId: String) {
        requireNotNull(bot.placement) { "Bot ${bot.id} has no placement" }
        registrations[bot.id] = Registration(bot, anchorId)
    }

    fun unregister(botId: String) {
        registrations.remove(botId)
    }

    fun onFrame(frame: SensorFrame): List<WakeEvent> {
        val events = mutableListOf<WakeEvent>()
        for (reg in registrations.values) {
            val placement = reg.bot.placement ?: continue
            for (trigger in placement.triggers) {
                when (trigger) {
                    is TriggerSpec.Gaze -> checkGaze(reg, trigger, placement.cooldownSeconds, frame)
                        ?.let(events::add)
                    is TriggerSpec.Schedule -> checkSchedule(reg, trigger, frame)?.let(events::add)
                }
            }
        }
        return events
    }

    private fun checkGaze(
        reg: Registration,
        trigger: TriggerSpec.Gaze,
        cooldownSeconds: Int,
        frame: SensorFrame,
    ): WakeEvent? {
        val anchor = frame.anchors[reg.anchorId]
        val looking = frame.worn && anchor != null && isLookingAt(frame, anchor, trigger)
        if (!looking) {
            reg.gazeStartMillis = null
            reg.sawSceneChange = false
            return null
        }
        val start = reg.gazeStartMillis ?: frame.elapsedMillis.also { reg.gazeStartMillis = it }
        if (frame.sceneChange >= trigger.sceneChangeThreshold) reg.sawSceneChange = true

        val dwelled = frame.elapsedMillis - start >= trigger.dwellMillis
        val sceneOk = !trigger.requireSceneChange || reg.sawSceneChange
        val last = reg.lastGazeWakeMillis
        val cooledDown = last == null || frame.elapsedMillis - last >= cooldownSeconds * 1000L
        if (!(dwelled && sceneOk && cooledDown)) return null

        reg.lastGazeWakeMillis = frame.elapsedMillis
        reg.gazeStartMillis = null
        reg.sawSceneChange = false
        return WakeEvent(reg.bot.id, reg.anchorId, WakeReason.GAZE, Delivery.HEADSET)
    }

    private fun isLookingAt(frame: SensorFrame, anchor: Vec3, trigger: TriggerSpec.Gaze): Boolean {
        val toAnchor = anchor - frame.headPosition
        val distance = toAnchor.length()
        if (distance > trigger.maxDistanceMeters || distance < 1e-4f) return false
        val gazeLen = frame.gazeDirection.length()
        if (gazeLen < 1e-4f) return false
        val cos = (toAnchor.dot(frame.gazeDirection) / (distance * gazeLen)).coerceIn(-1f, 1f)
        val angleDeg = Math.toDegrees(acos(cos).toDouble())
        return angleDeg <= trigger.coneDegrees
    }

    private fun checkSchedule(reg: Registration, trigger: TriggerSpec.Schedule, frame: SensorFrame): WakeEvent? {
        val today: LocalDate = frame.now.toLocalDate()
        for (slot in trigger.times) {
            val slotTime = LocalTime.parse(slot)
            val slotStart = LocalDateTime.of(today, slotTime)
            val inWindow = !frame.now.isBefore(slotStart) &&
                frame.now.isBefore(slotStart.plusMinutes(trigger.windowMinutes.toLong()))
            val key = slotStart.toString()
            if (inWindow && reg.firedSlots.add(key)) {
                // Not wearing the glasses? Still remind them, on the phone/tablet.
                val delivery = if (frame.worn) Delivery.HEADSET else Delivery.COMPANION_DEVICE
                return WakeEvent(reg.bot.id, reg.anchorId, WakeReason.SCHEDULE, delivery, slot)
            }
        }
        // Forget fired slots from previous days so memory stays bounded.
        reg.firedSlots.removeAll { !it.startsWith(today.toString()) }
        return null
    }
}
