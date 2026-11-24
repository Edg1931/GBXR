package com.gbxr.core.behavior

/**
 * What a bot is doing right now. The XR layer maps each state to an avatar
 * animation, so the bot's body language always matches the conversation.
 */
enum class BotState(val animation: String) {
    SLEEPING("sleep"),
    IDLE("idle"),
    /** Just woke: turns toward the user. */
    NOTICING("look_at_user"),
    LISTENING("listen"),
    THINKING("think"),
    SPEAKING("talk"),
    /** Running a delegated task in the background. */
    WORKING("work"),
}

sealed interface BotSignal {
    data object Wake : BotSignal
    data object UserSpeechStarted : BotSignal
    data object UserSpeechStopped : BotSignal
    data object ResponseAudioStarted : BotSignal
    data object ResponseFinished : BotSignal
    data class TaskStarted(val taskId: String) : BotSignal
    data class TaskFinished(val taskId: String) : BotSignal
    data object Dismissed : BotSignal
    /** No interaction for a while. */
    data object Timeout : BotSignal
}

class BotStateMachine(initial: BotState = BotState.IDLE) {
    var state: BotState = initial
        private set

    private val runningTasks = mutableSetOf<String>()
    val hasRunningTasks: Boolean get() = runningTasks.isNotEmpty()

    /** Applies a signal and returns the new state. */
    fun on(signal: BotSignal): BotState {
        state = when (signal) {
            BotSignal.Wake -> if (state == BotState.SPEAKING) state else BotState.NOTICING
            // Barge-in: the user talking always wins, even over the bot speaking.
            BotSignal.UserSpeechStarted -> BotState.LISTENING
            BotSignal.UserSpeechStopped -> BotState.THINKING
            BotSignal.ResponseAudioStarted -> BotState.SPEAKING
            BotSignal.ResponseFinished -> restingState(BotState.LISTENING)
            is BotSignal.TaskStarted -> {
                runningTasks += signal.taskId
                if (state == BotState.SPEAKING || state == BotState.LISTENING) state else BotState.WORKING
            }
            is BotSignal.TaskFinished -> {
                runningTasks -= signal.taskId
                // Finished work: come back to report.
                if (state == BotState.WORKING) BotState.NOTICING else state
            }
            BotSignal.Dismissed -> restingState(BotState.IDLE)
            BotSignal.Timeout -> when (state) {
                BotState.SPEAKING, BotState.THINKING -> state
                BotState.IDLE -> if (hasRunningTasks) BotState.WORKING else BotState.SLEEPING
                else -> restingState(BotState.IDLE)
            }
        }
        return state
    }

    private fun restingState(otherwise: BotState) =
        if (hasRunningTasks) BotState.WORKING else otherwise
}
