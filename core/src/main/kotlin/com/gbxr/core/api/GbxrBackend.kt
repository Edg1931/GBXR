package com.gbxr.core.api

import com.gbxr.core.behavior.Priority
import com.gbxr.core.model.PerceptionKind
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.Base64

@Serializable
data class VoiceSessionGrant(
    val clientSecret: String,
    val expiresAt: Long,
    /** Ready-to-send `session.update` body (voice, instructions, tools). */
    val session: JsonObject,
)

@Serializable
data class PerceptionResult(
    /** What the bot should say, or null to stay quiet. */
    val say: String? = null,
    val priority: Priority = Priority.LOW,
    /** Structured findings (inventory, scam verdict, pills seen...). */
    val data: JsonElement? = null,
)

@Serializable
data class BotNotification(val botId: String, val text: String, val at: String, val taskId: String? = null)

class BackendException(val status: Int, message: String) : IOException(message)

/** What the bot director needs from the backend (fakeable in tests). */
interface BotBackend {
    fun voiceSession(botId: String): VoiceSessionGrant
    fun perceive(botId: String, kind: PerceptionKind, jpegFrames: List<ByteArray>): PerceptionResult
    fun callTool(botId: String, name: String, argumentsJson: String): String
    fun notifications(): List<BotNotification>
}

/**
 * Client for the GBXR backend. Blocking calls: run them off the main thread.
 * [authToken] returns the signed-in user's session JWT (Supabase/Firebase).
 */
class GbxrBackend(
    private val baseUrl: String,
    private val http: OkHttpClient,
    private val authToken: () -> String,
) : BotBackend {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val jsonType = "application/json".toMediaType()

    override fun voiceSession(botId: String): VoiceSessionGrant =
        post("/v1/voice/session", buildJsonObject { put("botId", botId) })
            .let { json.decodeFromString(VoiceSessionGrant.serializer(), it) }

    override fun perceive(botId: String, kind: PerceptionKind, jpegFrames: List<ByteArray>): PerceptionResult {
        val body = buildJsonObject {
            put("botId", botId)
            put("kind", json.encodeToJsonElement(kind))
            put("images", json.encodeToJsonElement(jpegFrames.map { Base64.getEncoder().encodeToString(it) }))
        }
        return json.decodeFromString(PerceptionResult.serializer(), post("/v1/perception", body))
    }

    /** Runs a tool the voice model called; returns the JSON to hand back to it. */
    override fun callTool(botId: String, name: String, argumentsJson: String): String {
        val args = runCatching { json.parseToJsonElement(argumentsJson) }.getOrElse { JsonObject(emptyMap()) }
        return post("/v1/tools/$name", buildJsonObject {
            put("botId", botId)
            put("args", args)
        })
    }

    /** Pending bot messages (sale alerts, finished tasks); each is returned once. */
    override fun notifications(): List<BotNotification> =
        json.decodeFromString(ListSerializer(BotNotification.serializer()), get("/v1/notifications"))

    private fun get(path: String): String {
        val request = Request.Builder()
            .url(baseUrl.trimEnd('/') + path)
            .header("Authorization", "Bearer ${authToken()}")
            .build()
        http.newCall(request).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw BackendException(resp.code, "GET $path failed: ${resp.code} $text")
            return text
        }
    }

    private fun post(path: String, body: JsonObject): String {
        val request = Request.Builder()
            .url(baseUrl.trimEnd('/') + path)
            .header("Authorization", "Bearer ${authToken()}")
            .post(body.toString().toRequestBody(jsonType))
            .build()
        http.newCall(request).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw BackendException(resp.code, "POST $path failed: ${resp.code} $text")
            return text
        }
    }
}
