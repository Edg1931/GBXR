package com.gbxr.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * A bot's identity: who it is, how it sounds, what it may do, and (for place
 * bots) where it lives in the room. Profiles live in the repo-level `bots` folder (one JSON file per bot) and are
 * shared by the app and the backend.
 */
@Serializable
data class BotProfile(
    val id: String,
    val name: String,
    val role: String,
    /** xAI voice id (built-in like "eve"/"ara", or a cloned voice id). */
    val voice: String,
    val personality: String,
    /** System prompt sent to the realtime voice session. */
    val instructions: String,
    /** glTF/GLB avatar file name inside the app's assets. */
    val avatar: String,
    val audience: Audience = Audience.GENERAL,
    /** Tool names this bot may call; the backend enforces the same list. */
    val tools: List<String> = emptyList(),
    val idleBehaviors: List<String> = emptyList(),
    /** Present only for bots that live at a place (fridge, pill box, door...). */
    val placement: Placement? = null,
) {
    companion object {
        val json = Json { ignoreUnknownKeys = true; classDiscriminator = "type" }
        fun parse(text: String): BotProfile = json.decodeFromString(serializer(), text)
    }
}

@Serializable
enum class Audience {
    @SerialName("general") GENERAL,
    @SerialName("senior") SENIOR,
}

@Serializable
data class Placement(
    /** Human label the user sees when placing the bot ("Fridge door"). */
    val anchorLabel: String,
    val triggers: List<TriggerSpec>,
    /** What the bot looks at when it wakes, if anything. */
    val perception: PerceptionKind = PerceptionKind.NONE,
    /** Minimum time between automatic wake-ups. */
    val cooldownSeconds: Int = 300,
)

@Serializable
sealed interface TriggerSpec {
    /** Wake when the wearer looks at the anchor from close by (e.g. opens the fridge). */
    @Serializable
    @SerialName("gaze")
    data class Gaze(
        val maxDistanceMeters: Float = 1.5f,
        val coneDegrees: Float = 15f,
        val dwellMillis: Long = 800,
        /** Also require the view to change (door opening), not just a glance. */
        val requireSceneChange: Boolean = false,
        val sceneChangeThreshold: Float = 0.35f,
    ) : TriggerSpec

    /** Wake at fixed local times, e.g. medication times ("08:00"). */
    @Serializable
    @SerialName("schedule")
    data class Schedule(
        val times: List<String>,
        val windowMinutes: Int = 60,
    ) : TriggerSpec
}

@Serializable
enum class PerceptionKind {
    @SerialName("none") NONE,
    @SerialName("fridge") FRIDGE,
    @SerialName("pills") PILLS,
    @SerialName("mail") MAIL,
    @SerialName("objects") OBJECTS,
    @SerialName("exercise") EXERCISE,
}
