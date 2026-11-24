package com.gbxr.core.director

import com.gbxr.core.api.BotBackend
import com.gbxr.core.api.VoiceSessionGrant
import com.gbxr.core.behavior.BotSignal
import com.gbxr.core.behavior.BotState
import com.gbxr.core.behavior.BotStateMachine
import com.gbxr.core.behavior.Priority
import com.gbxr.core.behavior.SpeakPolicy
import com.gbxr.core.model.BotProfile
import com.gbxr.core.model.PerceptionKind
import com.gbxr.core.place.Delivery
import com.gbxr.core.place.PlaceBotEngine
import com.gbxr.core.place.SensorFrame
import com.gbxr.core.place.WakeEvent
import com.gbxr.core.place.WakeReason
import com.gbxr.core.voice.VoiceListener
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.time.LocalDateTime
import java.util.concurrent.Executor

/** Grabs a few camera frames as JPEG (CameraX on device). */
fun interface CameraFrames {
    fun capture(count: Int): List<ByteArray>
}

/** The 3D (or 2D fallback) view: plays the bot's animation and shows captions. */
interface AvatarStage {
    fun setState(botId: String, state: BotState)
    fun showCaption(botId: String, text: String)
}

/** A live voice conversation with one bot. */
interface VoiceLink {
    fun say(text: String)
    fun sendToolResult(callId: String, outputJson: String)
    fun close()
}

fun interface VoiceConnector {
    /** Open the session (and start mic/speaker) for a bot. */
    fun connect(bot: BotProfile, grant: VoiceSessionGrant, listener: VoiceListener): VoiceLink
}

/** Phone/tablet notification, for when the glasses are off. */
fun interface CompanionNotifier {
    fun notify(bot: BotProfile, text: String)
}

/**
 * Runs the crew: wakes place bots, has them look (camera) and think (backend),
 * speaks through each bot's own voice session, runs their tool calls, and
 * keeps every avatar's body language in sync with what's happening.
 *
 * All blocking work runs on [io]; tests pass a same-thread executor.
 */
class BotDirector(
    bots: List<BotProfile>,
    private val backend: BotBackend,
    private val camera: CameraFrames,
    private val stage: AvatarStage,
    private val voice: VoiceConnector,
    private val companion: CompanionNotifier,
    private val io: Executor,
    private val policy: SpeakPolicy = SpeakPolicy(),
    /** Offline medication reminder for the pill bot (from MedicationSchedule). */
    private val medsReminder: (LocalDateTime) -> String? = { null },
    private val pillBotId: String = "pillpal",
) {
    private val bots = bots.associateBy { it.id }
    private val engine = PlaceBotEngine()
    private val machines = bots.associate { it.id to BotStateMachine() }
    private val links = mutableMapOf<String, VoiceLink>()
    private val json = Json { ignoreUnknownKeys = true }
    @Volatile private var worn = true
    @Volatile private var lastFrame: SensorFrame? = null

    /** Called when the user places a bot (or a saved anchor is restored). */
    fun placeBot(botId: String, anchorId: String) {
        engine.register(bot(botId), anchorId)
        signal(botId, BotSignal.Dismissed)
    }

    /** Feed ~10 frames/second from the XR layer. */
    fun onFrame(frame: SensorFrame) {
        worn = frame.worn
        lastFrame = frame
        for (wake in engine.onFrame(frame)) handleWake(wake, frame)
    }

    /** "Hey Nova" / tapping a bot / looking at a desk bot and talking. */
    fun summon(botId: String) {
        signal(botId, BotSignal.Wake)
        io.execute { ensureVoice(bot(botId)) }
    }

    fun dismiss(botId: String) {
        signal(botId, BotSignal.Dismissed)
        links.remove(botId)?.close()
    }

    /** Poll this every ~30 s: finished tasks, sale alerts, links sent to the phone. */
    fun checkNotifications() = io.execute {
        val notes = runCatching { backend.notifications() }.getOrDefault(emptyList())
        for (n in notes) {
            val bot = bots[n.botId] ?: continue
            if (n.taskId != null) {
                signal(bot.id, BotSignal.TaskFinished(n.taskId))
                deliver(bot, "${n.text}. Brief them on the result (use list_tasks for the details).", Priority.NORMAL)
            } else {
                deliver(bot, n.text, Priority.NORMAL)
            }
        }
    }

    fun state(botId: String): BotState = machines.getValue(botId).state

    // ------------------------------------------------------------------

    private fun handleWake(wake: WakeEvent, frame: SensorFrame) {
        val bot = bot(wake.botId)
        if (wake.delivery == Delivery.COMPANION_DEVICE) {
            // Glasses are off: remind on the phone/tablet instead.
            wakeMessage(bot, wake, frame)?.let { companion.notify(bot, it) }
            return
        }
        signal(bot.id, BotSignal.Wake)
        io.execute {
            val perception = bot.placement?.perception ?: PerceptionKind.NONE
            if (perception != PerceptionKind.NONE && perception != PerceptionKind.EXERCISE && wake.reason == WakeReason.GAZE) {
                val frames = runCatching { camera.capture(2) }.getOrDefault(emptyList())
                if (frames.isEmpty()) return@execute
                signal(bot.id, BotSignal.UserSpeechStopped) // "thinking" pose while it looks
                val result = runCatching { backend.perceive(bot.id, perception, frames) }.getOrNull()
                if (result?.say == null) {
                    signal(bot.id, BotSignal.Dismissed)
                    return@execute
                }
                deliver(bot, result.say, result.priority)
            } else {
                wakeMessage(bot, wake, frame)?.let { deliver(bot, it, Priority.NORMAL) }
            }
        }
    }

    private fun wakeMessage(bot: BotProfile, wake: WakeEvent, frame: SensorFrame): String? =
        if (bot.id == pillBotId) medsReminder(frame.now)
        else when (wake.reason) {
            WakeReason.SCHEDULE -> "It's your scheduled check-in time. Greet them and start your routine."
            WakeReason.GAZE -> "They just came over to the ${bot.placement?.anchorLabel?.lowercase() ?: "spot where you live"}. Help with what you do there."
        }

    private fun deliver(bot: BotProfile, text: String, priority: Priority) {
        val frame = lastFrame
        val time = frame?.now?.toLocalTime() ?: LocalDateTime.now().toLocalTime()
        val elapsed = frame?.elapsedMillis ?: 0L
        if (!policy.shouldSpeak(priority, time, elapsed)) {
            signal(bot.id, BotSignal.Dismissed)
            return
        }
        if (!worn) {
            companion.notify(bot, text)
            return
        }
        stage.showCaption(bot.id, text)
        ensureVoice(bot)?.say(text)
    }

    @Synchronized
    private fun ensureVoice(bot: BotProfile): VoiceLink? {
        links[bot.id]?.let { return it }
        val grant = runCatching { backend.voiceSession(bot.id) }.getOrNull() ?: return null
        val link = voice.connect(bot, grant, listenerFor(bot))
        links[bot.id] = link
        return link
    }

    private fun listenerFor(bot: BotProfile) = object : VoiceListener {
        override fun onUserSpeechStarted() = signal(bot.id, BotSignal.UserSpeechStarted)
        override fun onUserSpeechStopped() = signal(bot.id, BotSignal.UserSpeechStopped)
        private var speaking = false
        override fun onAudio(pcm16: ByteArray) {
            if (!speaking) {
                speaking = true
                signal(bot.id, BotSignal.ResponseAudioStarted)
            }
        }
        override fun onTranscript(text: String, final: Boolean) {
            if (final) stage.showCaption(bot.id, text)
        }
        override fun onResponseDone() {
            speaking = false
            signal(bot.id, BotSignal.ResponseFinished)
        }
        override fun onToolCall(callId: String, name: String, argumentsJson: String) = io.execute {
            val output = runCatching { backend.callTool(bot.id, name, argumentsJson) }
                .getOrElse { """{"error":"${(it.message ?: "failed").replace("\"", "'")}"}""" }
            if (name == "create_task") taskIdFrom(output)?.let { signal(bot.id, BotSignal.TaskStarted(it)) }
            links[bot.id]?.sendToolResult(callId, output)
        }
        override fun onClosed() {
            links.remove(bot.id)
        }
    }

    private fun taskIdFrom(output: String): String? = runCatching {
        json.parseToJsonElement(output).jsonObject["taskId"]?.jsonPrimitive?.contentOrNull
    }.getOrNull()

    private fun signal(botId: String, s: BotSignal) {
        val machine = machines[botId] ?: return
        val before = machine.state
        val after = synchronized(machine) { machine.on(s) }
        if (after != before) stage.setState(botId, after)
    }

    private fun bot(id: String) = bots[id] ?: error("unknown bot $id")
}
