package com.gbxr.core

import com.gbxr.core.api.BotBackend
import com.gbxr.core.api.BotNotification
import com.gbxr.core.api.PerceptionResult
import com.gbxr.core.api.VoiceSessionGrant
import com.gbxr.core.behavior.BotState
import com.gbxr.core.behavior.Priority
import com.gbxr.core.director.AvatarStage
import com.gbxr.core.director.BotDirector
import com.gbxr.core.director.VoiceLink
import com.gbxr.core.model.BotProfile
import com.gbxr.core.model.PerceptionKind
import com.gbxr.core.place.SensorFrame
import com.gbxr.core.place.Vec3
import com.gbxr.core.voice.VoiceListener
import kotlinx.serialization.json.JsonObject
import java.io.File
import java.time.LocalDateTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class BotDirectorTest {
    private val roster = generateSequence(File("").absoluteFile) { it.parentFile }
        .map { File(it, "bots") }.first { it.isDirectory }
        .listFiles { f -> f.extension == "json" }!!.map { BotProfile.parse(it.readText()) }

    private class FakeBackend : BotBackend {
        val perceived = mutableListOf<Pair<String, PerceptionKind>>()
        val tools = mutableListOf<String>()
        var perception = PerceptionResult("Your spinach needs using today.", Priority.NORMAL)
        var pending = listOf<BotNotification>()
        override fun voiceSession(botId: String) = VoiceSessionGrant("s", 0, JsonObject(emptyMap()))
        override fun perceive(botId: String, kind: PerceptionKind, jpegFrames: List<ByteArray>) =
            perception.also { perceived += botId to kind }
        override fun callTool(botId: String, name: String, argumentsJson: String): String {
            tools += "$botId:$name"
            return if (name == "create_task") """{"taskId":"t9","status":"queued"}""" else """{"ok":true}"""
        }
        override fun notifications() = pending.also { pending = emptyList() }
    }

    private class Harness(roster: List<BotProfile>) {
        val backend = FakeBackend()
        val said = mutableListOf<Pair<String, String>>()
        val phone = mutableListOf<Pair<String, String>>()
        val states = mutableListOf<Pair<String, BotState>>()
        val listeners = mutableMapOf<String, VoiceListener>()
        val toolResults = mutableListOf<String>()
        val director = BotDirector(
            bots = roster,
            backend = backend,
            camera = { n -> List(n) { byteArrayOf(1) } },
            stage = object : AvatarStage {
                override fun setState(botId: String, state: BotState) { states += botId to state }
                override fun showCaption(botId: String, text: String) {}
            },
            voice = { bot, _, listener ->
                listeners[bot.id] = listener
                object : VoiceLink {
                    override fun say(text: String) { said += bot.id to text }
                    override fun sendToolResult(callId: String, outputJson: String) { toolResults += outputJson }
                    override fun close() {}
                }
            },
            companion = { bot, text -> phone += bot.id to text },
            io = { it.run() },
            medsReminder = { "It's time for your Metformin." },
        )
    }

    private val fridge = Vec3(0f, 1.2f, -1f)
    private val head = Vec3(0f, 1.6f, 0f)
    private val gaze = (fridge - head).let { Vec3(it.x / it.length(), it.y / it.length(), it.z / it.length()) }
    private val noon = LocalDateTime.of(2026, 11, 24, 12, 0)

    @Test
    fun openingTheFridgeMakesPantryLookAndSpeak() {
        val h = Harness(roster)
        h.director.placeBot("pantry", "fridge-anchor")
        h.director.onFrame(SensorFrame(noon, 0, head, gaze, mapOf("fridge-anchor" to fridge), sceneChange = 0.8f))
        h.director.onFrame(SensorFrame(noon, 900, head, gaze, mapOf("fridge-anchor" to fridge), sceneChange = 0.8f))

        assertEquals(listOf("pantry" to PerceptionKind.FRIDGE), h.backend.perceived)
        assertEquals(listOf("pantry" to "Your spinach needs using today."), h.said)
        assertTrue(h.states.contains("pantry" to BotState.NOTICING))

        // Bot starts talking, then finishes: body language follows.
        h.listeners.getValue("pantry").onAudio(byteArrayOf(0))
        assertEquals(BotState.SPEAKING, h.director.state("pantry"))
        h.listeners.getValue("pantry").onResponseDone()
        assertEquals(BotState.LISTENING, h.director.state("pantry"))
    }

    @Test
    fun pillReminderGoesToPhoneWhenGlassesAreOff() {
        val h = Harness(roster)
        h.director.placeBot("pillpal", "pills-anchor")
        val morning = LocalDateTime.of(2026, 11, 24, 8, 2)
        h.director.onFrame(SensorFrame(morning, 0, head, Vec3(0f, 0f, 1f), emptyMap(), worn = false))
        assertEquals(listOf("pillpal" to "It's time for your Metformin."), h.phone)
        assertTrue(h.said.isEmpty())
    }

    @Test
    fun delegatedTaskShowsWorkingAndReportsBack() {
        val h = Harness(roster)
        h.director.summon("nova")
        h.director.onFrame(SensorFrame(noon, 0, head, gaze, emptyMap()))
        h.listeners.getValue("nova").onToolCall("c1", "create_task", """{"title":"Compare glasses"}""")
        assertEquals(listOf("nova:create_task"), h.backend.tools)
        assertEquals(1, h.toolResults.size)
        h.director.dismiss("nova")
        assertEquals(BotState.WORKING, h.director.state("nova"))

        h.backend.pending = listOf(BotNotification("nova", "Task finished: Compare glasses", "t", taskId = "t9"))
        h.director.checkNotifications()
        assertEquals(BotState.NOTICING, h.director.state("nova"))
        assertTrue(h.said.last().second.startsWith("Task finished: Compare glasses"))
    }

    @Test
    fun quietFindingsStaySilent() {
        val h = Harness(roster)
        h.backend.perception = PerceptionResult(null, Priority.LOW)
        h.director.placeBot("finder", "counter")
        val counter = Vec3(0f, 1.0f, -1.5f)
        val look = (counter - head).let { Vec3(it.x / it.length(), it.y / it.length(), it.z / it.length()) }
        h.director.onFrame(SensorFrame(noon, 0, head, look, mapOf("counter" to counter)))
        h.director.onFrame(SensorFrame(noon, 2100, head, look, mapOf("counter" to counter)))
        assertEquals(listOf("finder" to PerceptionKind.OBJECTS), h.backend.perceived)
        assertTrue(h.said.isEmpty())
    }
}
