package com.gbxr.core

import com.gbxr.core.api.GbxrBackend
import com.gbxr.core.behavior.Priority
import com.gbxr.core.model.PerceptionKind
import com.gbxr.core.voice.RealtimeVoiceClient
import com.gbxr.core.voice.VoiceListener
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class VoiceAndBackendTest {

    @Test
    fun voiceClientSendsSessionAuthAndHandlesEvents() {
        val server = MockWebServer()
        val fromClient = LinkedBlockingQueue<String>()
        val audio = byteArrayOf(1, 2, 3, 4)
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send("""{"type":"input_audio_buffer.speech_started"}""")
                webSocket.send("""{"type":"response.output_audio.delta","delta":"${Base64.getEncoder().encodeToString(audio)}"}""")
                webSocket.send("""{"type":"response.audio_transcript.done","transcript":"Hi Edna"}""")
                webSocket.send("""{"type":"response.function_call_arguments.done","call_id":"c1","name":"log_dose","arguments":"{\"medicationId\":\"m1\"}"}""")
                webSocket.send("""{"type":"response.done"}""")
            }
            override fun onMessage(webSocket: WebSocket, text: String) { fromClient.add(text) }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000, null) }
        }))
        server.start()

        val done = CountDownLatch(1)
        val got = mutableListOf<String>()
        var audioOut = ByteArray(0)
        val client = RealtimeVoiceClient(OkHttpClient(), server.url("/v1/realtime").toString().replace("http", "ws"))
        client.connect("tok123", buildJsonObject { put("voice", "ara") }, object : VoiceListener {
            override fun onUserSpeechStarted() { got += "speech" }
            override fun onAudio(pcm16: ByteArray) { audioOut = pcm16 }
            override fun onTranscript(text: String, final: Boolean) { if (final) got += "t:$text" }
            override fun onToolCall(callId: String, name: String, argumentsJson: String) {
                got += "tool:$name:$argumentsJson"
                client.sendToolResult(callId, """{"ok":true}""")
            }
            override fun onResponseDone() { done.countDown() }
        })
        assertTrue(done.await(5, TimeUnit.SECONDS))

        val request = server.takeRequest()
        assertEquals("xai-client-secret.tok123", request.getHeader("Sec-WebSocket-Protocol"))
        assertEquals(listOf("speech", "t:Hi Edna", "tool:log_dose:{\"medicationId\":\"m1\"}"), got)
        assertContentEquals(audio, audioOut)

        val first = Json.parseToJsonElement(fromClient.poll(5, TimeUnit.SECONDS)!!).jsonObject
        assertEquals("session.update", first["type"]!!.jsonPrimitive.content)
        val output = Json.parseToJsonElement(fromClient.poll(5, TimeUnit.SECONDS)!!).jsonObject
        assertEquals("function_call_output", output["item"]!!.jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals("response.create",
            Json.parseToJsonElement(fromClient.poll(5, TimeUnit.SECONDS)!!).jsonObject["type"]!!.jsonPrimitive.content)
        client.close()
        server.shutdown()
    }

    @Test
    fun backendPerceiveSendsAuthAndParses() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("""{"say":"Your spinach needs using today.","priority":"normal","data":{"items":[]}}"""))
        server.start()
        val api = GbxrBackend(server.url("/").toString(), OkHttpClient()) { "jwt-abc" }
        val result = api.perceive("pantry", PerceptionKind.FRIDGE, listOf(byteArrayOf(9, 9)))
        assertEquals(Priority.NORMAL, result.priority)
        assertEquals("Your spinach needs using today.", result.say)

        val req = server.takeRequest()
        assertEquals("/v1/perception", req.path)
        assertEquals("Bearer jwt-abc", req.getHeader("Authorization"))
        val body = Json.parseToJsonElement(req.body.readUtf8()).jsonObject
        assertEquals("fridge", body["kind"]!!.jsonPrimitive.content)
        server.shutdown()
    }
}
