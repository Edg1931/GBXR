package com.gbxr.app.ui

import androidx.compose.runtime.mutableStateMapOf
import com.gbxr.core.behavior.BotState
import com.gbxr.core.director.AvatarStage

/**
 * Observable state of every bot, shared by the 3D stage and the 2D companion
 * screen. Compose recomposes when these maps change.
 */
class CrewState : AvatarStage {
    val states = mutableStateMapOf<String, BotState>()
    val captions = mutableStateMapOf<String, String>()
    val mouth = mutableStateMapOf<String, Float>()

    /** Extra listener, e.g. the XR stage playing animations. */
    var onStateChanged: (String, BotState) -> Unit = { _, _ -> }

    override fun setState(botId: String, state: BotState) {
        states[botId] = state
        onStateChanged(botId, state)
    }

    override fun showCaption(botId: String, text: String) {
        captions[botId] = text
    }
}
