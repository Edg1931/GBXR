package com.gbxr.core.voice

import com.gbxr.core.model.BotProfile
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.Base64

/** What the voice session reports back to the app. */
interface VoiceListener {
    fun onConnected() {}
    fun onUserSpeechStarted() {}
    fun onUserSpeechStopped() {}
    /** Raw PCM16 audio from the bot, to play and to drive lip-sync. */
    fun onAudio(pcm16: ByteArray) {}
    fun onTranscript(text: String, final: Boolean) {}
    /** The model wants a tool run. Reply with [RealtimeVoiceClient.sendToolResult]. */
    fun onToolCall(callId: String, name: String, argumentsJson: String) {}
    fun onResponseDone() {}
    fun onError(message: String) {}
    fun onClosed() {}
}

/**
 * One bot = one realtime voice session with xAI (wss://api.x.ai/v1/realtime).
 *
 * The app never holds the xAI API key: the backend mints a short-lived client
 * secret per session, passed here as [clientSecret] and sent as the
 * `xai-client-secret.<token>` WebSocket subprotocol.
 *
 * The protocol follows the OpenAI Realtime event format, which xAI states it is
 * compatible with. Where event names differ between spec versions (e.g.
 * `response.audio.delta` vs `response.output_audio.delta`) both are accepted.
 */
class RealtimeVoiceClient(
    private val http: OkHttpClient,
    private val url: String = "wss://api.x.ai/v1/realtime",
) {
    private var socket: WebSocket? = null
    private val json = Json { ignoreUnknownKeys = true }

    fun connect(clientSecret: String, session: JsonObject, listener: VoiceListener) {
        val request = Request.Builder()
            .url(url)
            .header("Sec-WebSocket-Protocol", "xai-client-secret.$clientSecret")
            .build()
        socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(buildJsonObject {
                    put("type", "session.update")
                    put("session", session)
                }.toString())
                listener.onConnected()
            }

            override fun onMessage(webSocket: WebSocket, text: String) = dispatch(text, listener)
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) = Unit

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                listener.onError(t.message ?: "voice connection failed")
                listener.onClosed()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = listener.onClosed()
        })
    }

    /** Stream microphone audio (PCM16 mono, at the session's input rate). */
    fun sendAudio(pcm16: ByteArray) {
        send(buildJsonObject {
            put("type", "input_audio_buffer.append")
            put("audio", Base64.getEncoder().encodeToString(pcm16))
        })
    }

    /** Ask the bot to say something proactively (e.g. a pill reminder). */
    fun say(text: String) {
        send(buildJsonObject {
            put("type", "conversation.item.create")
            putJsonObject("item") {
                put("type", "message")
                put("role", "user")
                put("content", JsonArray(listOf(buildJsonObject {
                    put("type", "input_text")
                    put("text", "[system event — speak this to the user in your own voice] $text")
                })))
            }
        })
        send(buildJsonObject { put("type", "response.create") })
    }

    fun sendToolResult(callId: String, outputJson: String) {
        send(buildJsonObject {
            put("type", "conversation.item.create")
            putJsonObject("item") {
                put("type", "function_call_output")
                put("call_id", callId)
                put("output", outputJson)
            }
        })
        send(buildJsonObject { put("type", "response.create") })
    }

    fun close() {
        socket?.close(1000, "bye")
        socket = null
    }

    private fun send(obj: JsonObject) {
        socket?.send(obj.toString())
    }

    internal fun dispatch(text: String, listener: VoiceListener) {
        val event = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        when (event.str("type")) {
            "input_audio_buffer.speech_started" -> listener.onUserSpeechStarted()
            "input_audio_buffer.speech_stopped" -> listener.onUserSpeechStopped()
            "response.audio.delta", "response.output_audio.delta" ->
                event.str("delta")?.let { listener.onAudio(Base64.getDecoder().decode(it)) }
            "response.audio_transcript.delta", "response.output_audio_transcript.delta" ->
                event.str("delta")?.let { listener.onTranscript(it, final = false) }
            "response.audio_transcript.done", "response.output_audio_transcript.done" ->
                event.str("transcript")?.let { listener.onTranscript(it, final = true) }
            "response.function_call_arguments.done" -> {
                val callId = event.str("call_id") ?: return
                val name = event.str("name") ?: return
                listener.onToolCall(callId, name, event.str("arguments") ?: "{}")
            }
            "response.done" -> listener.onResponseDone()
            "error" -> listener.onError(
                (event["error"] as? JsonObject)?.str("message") ?: text,
            )
        }
    }

    private fun JsonObject.str(key: String): String? =
        (this[key] as? JsonElement)?.let { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }

    companion object {
        /**
         * Builds the `session.update` body for a bot. The backend returns this
         * ready-made (with tool schemas) from /v1/voice/session; this helper is
         * the offline fallback.
         */
        fun sessionFor(bot: BotProfile, tools: JsonArray = JsonArray(emptyList())): JsonObject = buildJsonObject {
            put("voice", bot.voice)
            put("instructions", bot.instructions)
            putJsonObject("turn_detection") { put("type", "server_vad") }
            put("tools", tools)
        }
    }
}
