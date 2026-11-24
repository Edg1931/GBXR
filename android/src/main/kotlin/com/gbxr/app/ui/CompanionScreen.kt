package com.gbxr.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.gbxr.core.behavior.BotState
import com.gbxr.core.model.BotProfile

/**
 * The 2D version for phones and tablets (or when the glasses are off).
 * Large text and big buttons, one action per bot: talk to it.
 * In XR the same composable is shown as a floating panel.
 */
@Composable
fun CompanionScreen(
    bots: List<BotProfile>,
    crew: CrewState,
    onTalk: (String) -> Unit,
    onDone: (String) -> Unit,
    /** XR only: drop a place bot on the surface you're looking at. */
    onPlace: ((String) -> Unit)? = null,
) {
    LazyColumn(
        modifier = Modifier.padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        items(bots, key = { it.id }) { bot ->
            val state = crew.states[bot.id] ?: BotState.IDLE
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(20.dp)) {
                    Text(bot.name, fontSize = 28.sp, style = MaterialTheme.typography.headlineMedium)
                    Text(bot.role, fontSize = 18.sp)
                    Text(statusLabel(state), fontSize = 18.sp, modifier = Modifier.padding(top = 4.dp))
                    crew.captions[bot.id]?.let {
                        Text("“$it”", fontSize = 22.sp, modifier = Modifier.padding(top = 12.dp))
                    }
                    Row(Modifier.padding(top = 16.dp)) {
                        Button(onClick = { onTalk(bot.id) }) { Text("Talk to ${bot.name}", fontSize = 20.sp) }
                        Spacer(Modifier.width(12.dp))
                        val placement = bot.placement
                        if (onPlace != null && placement != null) {
                            OutlinedButton(onClick = { onPlace(bot.id) }) {
                                Text("Place on ${placement.anchorLabel.lowercase()}", fontSize = 18.sp)
                            }
                            Spacer(Modifier.width(12.dp))
                        }
                        if (state != BotState.IDLE && state != BotState.SLEEPING) {
                            OutlinedButton(onClick = { onDone(bot.id) }) { Text("Done", fontSize = 20.sp) }
                        }
                    }
                }
            }
        }
    }
}

private fun statusLabel(s: BotState) = when (s) {
    BotState.SLEEPING -> "Resting"
    BotState.IDLE -> "Ready"
    BotState.NOTICING -> "Has something for you"
    BotState.LISTENING -> "Listening…"
    BotState.THINKING -> "Thinking…"
    BotState.SPEAKING -> "Talking"
    BotState.WORKING -> "Working on a task"
}
