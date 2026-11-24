package com.gbxr.core

import com.gbxr.core.behavior.BotSignal
import com.gbxr.core.behavior.BotState
import com.gbxr.core.behavior.BotStateMachine
import com.gbxr.core.behavior.Priority
import com.gbxr.core.behavior.SpeakPolicy
import com.gbxr.core.care.DoseLog
import com.gbxr.core.care.DoseStatus
import com.gbxr.core.care.Medication
import com.gbxr.core.care.MedicationSchedule
import java.time.LocalDateTime
import java.time.LocalTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class BehaviorAndCareTest {

    @Test
    fun conversationFlowAndBargeIn() {
        val sm = BotStateMachine()
        assertEquals(BotState.NOTICING, sm.on(BotSignal.Wake))
        assertEquals(BotState.LISTENING, sm.on(BotSignal.UserSpeechStarted))
        assertEquals(BotState.THINKING, sm.on(BotSignal.UserSpeechStopped))
        assertEquals(BotState.SPEAKING, sm.on(BotSignal.ResponseAudioStarted))
        assertEquals(BotState.LISTENING, sm.on(BotSignal.UserSpeechStarted), "user interrupts")
    }

    @Test
    fun delegatedWorkShowsWorkingThenComesBackToReport() {
        val sm = BotStateMachine()
        sm.on(BotSignal.Wake)
        sm.on(BotSignal.TaskStarted("t1"))
        assertEquals(BotState.WORKING, sm.state)
        assertEquals(BotState.WORKING, sm.on(BotSignal.Dismissed), "keeps working after you walk away")
        assertEquals(BotState.WORKING, sm.on(BotSignal.Timeout))
        assertEquals(BotState.NOTICING, sm.on(BotSignal.TaskFinished("t1")))
        sm.on(BotSignal.Dismissed)
        assertEquals(BotState.SLEEPING, sm.on(BotSignal.Timeout))
    }

    @Test
    fun speakPolicyRateLimitsLowAndRespectsQuietHours() {
        val p = SpeakPolicy(maxLowPerHour = 2)
        val noon = LocalTime.NOON
        assertTrue(p.shouldSpeak(Priority.LOW, noon, 0))
        assertTrue(p.shouldSpeak(Priority.LOW, noon, 1000))
        assertFalse(p.shouldSpeak(Priority.LOW, noon, 2000))
        assertTrue(p.shouldSpeak(Priority.LOW, noon, 3_601_000), "an hour later")

        val night = LocalTime.of(23, 0)
        assertFalse(p.shouldSpeak(Priority.NORMAL, night, 0))
        assertTrue(p.shouldSpeak(Priority.URGENT, night, 0), "urgent always speaks")
        assertTrue(p.isQuiet(LocalTime.of(6, 0)))
        assertFalse(p.isQuiet(LocalTime.of(8, 0)))
    }

    private val meds = listOf(
        Medication("lisinopril", "Lisinopril", "small white round pill", "10 mg", listOf("08:00")),
        Medication("metformin", "Metformin", "large white oval pill", "500 mg", listOf("08:00", "18:00"), withFood = true),
    )

    @Test
    fun doseStatuses() {
        val s = MedicationSchedule(meds)
        val now = LocalDateTime.of(2026, 11, 24, 8, 30)
        val logs = listOf(DoseLog("lisinopril", "2026-11-24T08:00", "2026-11-24T08:10"))
        val occ = s.occurrencesOn(now.toLocalDate(), now, logs).associate { it.slotKey to it.status }
        assertEquals(DoseStatus.TAKEN, occ["lisinopril@2026-11-24T08:00"])
        assertEquals(DoseStatus.DUE, occ["metformin@2026-11-24T08:00"])
        assertEquals(DoseStatus.UPCOMING, occ["metformin@2026-11-24T18:00"])

        val later = now.plusHours(1)
        assertEquals(DoseStatus.MISSED,
            s.occurrencesOn(later.toLocalDate(), later, logs).first { it.medication.id == "metformin" }.status)
    }

    @Test
    fun reminderLineIsConcrete() {
        val s = MedicationSchedule(meds)
        val now = LocalDateTime.of(2026, 11, 24, 8, 5)
        val line = s.reminderLine(s.dueNow(now, emptyList()))!!
        assertTrue(line.contains("2 medicines"))
        assertTrue(line.contains("large white oval pill"))
        assertTrue(line.contains("with some food"))
        assertNull(s.reminderLine(emptyList()))
    }
}
