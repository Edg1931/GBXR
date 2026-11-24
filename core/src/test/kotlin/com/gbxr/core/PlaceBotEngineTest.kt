package com.gbxr.core

import com.gbxr.core.model.BotProfile
import com.gbxr.core.model.Placement
import com.gbxr.core.model.TriggerSpec
import com.gbxr.core.place.Delivery
import com.gbxr.core.place.PlaceBotEngine
import com.gbxr.core.place.SensorFrame
import com.gbxr.core.place.Vec3
import com.gbxr.core.place.WakeReason
import java.io.File
import java.time.LocalDateTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PlaceBotEngineTest {
    private val fridge = Vec3(0f, 1.2f, -1f)
    private val head = Vec3(0f, 1.6f, 0f)
    private val towardFridge = (fridge - head).let { Vec3(it.x / it.length(), it.y / it.length(), it.z / it.length()) }
    private val awayFromFridge = Vec3(0f, 0f, 1f)
    private val t0 = LocalDateTime.of(2026, 11, 24, 12, 0)

    private fun bot(vararg triggers: TriggerSpec, cooldown: Int = 300) = BotProfile(
        id = "pantry", name = "Pantry", role = "grocery", voice = "eve", personality = "", instructions = "",
        avatar = "pantry.glb", placement = Placement("Fridge door", triggers.toList(), cooldownSeconds = cooldown),
    )

    private fun frame(ms: Long, gaze: Vec3 = towardFridge, change: Float = 0f, worn: Boolean = true, now: LocalDateTime = t0) =
        SensorFrame(now, ms, head, gaze, mapOf("a1" to fridge), change, worn)

    @Test
    fun gazeNeedsDwellAndSceneChange() {
        val engine = PlaceBotEngine()
        engine.register(bot(TriggerSpec.Gaze(dwellMillis = 800, requireSceneChange = true)), "a1")

        // Looking but nothing changed (just glanced at the closed fridge): no wake.
        assertTrue(engine.onFrame(frame(0)).isEmpty())
        assertTrue(engine.onFrame(frame(1000)).isEmpty())

        // Door opens while looking (dwell already satisfied): wakes right away.
        val wakes = engine.onFrame(frame(1100, change = 0.6f))
        assertEquals(1, wakes.size)
        assertEquals(WakeReason.GAZE, wakes[0].reason)
        assertEquals("a1", wakes[0].anchorId)
        assertTrue(engine.onFrame(frame(1200, change = 0.6f)).isEmpty(), "cooldown")
    }

    @Test
    fun lookingAwayResetsDwell() {
        val engine = PlaceBotEngine()
        engine.register(bot(TriggerSpec.Gaze(dwellMillis = 800)), "a1")
        engine.onFrame(frame(0))
        engine.onFrame(frame(500, gaze = awayFromFridge))
        assertTrue(engine.onFrame(frame(900)).isEmpty(), "dwell restarted at 900")
        assertEquals(1, engine.onFrame(frame(1700)).size)
    }

    @Test
    fun cooldownPreventsRepeatWakes() {
        val engine = PlaceBotEngine()
        engine.register(bot(TriggerSpec.Gaze(dwellMillis = 0), cooldown = 60), "a1")
        assertEquals(1, engine.onFrame(frame(0)).size)
        engine.onFrame(frame(100, gaze = awayFromFridge))
        assertTrue(engine.onFrame(frame(30_000)).isEmpty())
        engine.onFrame(frame(30_100, gaze = awayFromFridge))
        assertEquals(1, engine.onFrame(frame(61_000)).size)
    }

    @Test
    fun tooFarAwayDoesNotWake() {
        val engine = PlaceBotEngine()
        engine.register(bot(TriggerSpec.Gaze(dwellMillis = 0, maxDistanceMeters = 0.5f)), "a1")
        assertTrue(engine.onFrame(frame(0)).isEmpty())
    }

    @Test
    fun scheduleFiresOncePerSlotAndFallsBackToCompanionDevice() {
        val engine = PlaceBotEngine()
        engine.register(bot(TriggerSpec.Schedule(listOf("08:00", "20:00"), windowMinutes = 60)), "a1")
        val morning = LocalDateTime.of(2026, 11, 24, 8, 5)

        val first = engine.onFrame(frame(0, gaze = awayFromFridge, worn = false, now = morning))
        assertEquals(1, first.size)
        assertEquals("08:00", first[0].slot)
        assertEquals(Delivery.COMPANION_DEVICE, first[0].delivery)

        assertTrue(engine.onFrame(frame(1000, now = morning.plusMinutes(10))).isEmpty(), "already fired")
        assertTrue(engine.onFrame(frame(2000, now = morning.plusHours(2))).isEmpty(), "outside window")

        val nextDay = engine.onFrame(frame(3000, now = morning.plusDays(1)))
        assertEquals(1, nextDay.size)
        assertEquals(Delivery.HEADSET, nextDay[0].delivery)
    }

    @Test
    fun allShippedBotProfilesParse() {
        val dir = generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, "bots") }.first { it.isDirectory }
        val files = dir.listFiles { f -> f.extension == "json" }!!.toList()
        assertTrue(files.size >= 8, "expected the bot roster, found ${files.size}")
        for (f in files) {
            val bot = BotProfile.parse(f.readText())
            assertEquals(f.nameWithoutExtension, bot.id, "file name must match id")
        }
    }
}
