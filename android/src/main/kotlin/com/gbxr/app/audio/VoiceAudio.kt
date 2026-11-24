package com.gbxr.app.audio

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import com.gbxr.core.api.VoiceSessionGrant
import com.gbxr.core.director.VoiceConnector
import com.gbxr.core.director.VoiceLink
import com.gbxr.core.model.BotProfile
import com.gbxr.core.voice.RealtimeVoiceClient
import com.gbxr.core.voice.VoiceListener
import okhttp3.OkHttpClient
import kotlin.concurrent.thread
import kotlin.math.sqrt

private const val SAMPLE_RATE = 24_000 // PCM16 mono, the realtime API's usual rate

/**
 * Connects a bot's realtime voice session to the mic and speaker.
 * [onMouth] gets 0..1 loudness of the bot's voice, to drive lip-sync.
 *
 * Only one bot holds the mic at a time: the one you're talking to.
 */
class AndroidVoiceConnector(
    private val http: OkHttpClient,
    private val onMouth: (botId: String, level: Float) -> Unit,
) : VoiceConnector {

    @Volatile private var micOwner: String? = null

    override fun connect(bot: BotProfile, grant: VoiceSessionGrant, listener: VoiceListener): VoiceLink {
        val client = RealtimeVoiceClient(http)
        val speaker = Speaker()
        micOwner = bot.id
        val mic = Mic { pcm -> if (micOwner == bot.id) client.sendAudio(pcm) }

        client.connect(grant.clientSecret, grant.session, object : VoiceListener by listener {
            override fun onConnected() {
                mic.start()
                listener.onConnected()
            }
            override fun onUserSpeechStarted() {
                speaker.flush() // barge-in: stop talking when the person talks
                listener.onUserSpeechStarted()
            }
            override fun onAudio(pcm16: ByteArray) {
                speaker.play(pcm16)
                onMouth(bot.id, rms(pcm16))
                listener.onAudio(pcm16)
            }
            override fun onResponseDone() {
                onMouth(bot.id, 0f)
                listener.onResponseDone()
            }
            override fun onClosed() {
                mic.stop()
                speaker.release()
                listener.onClosed()
            }
        })

        return object : VoiceLink {
            override fun say(text: String) = client.say(text)
            override fun sendToolResult(callId: String, outputJson: String) = client.sendToolResult(callId, outputJson)
            override fun close() {
                client.close()
                mic.stop()
                speaker.release()
            }
        }
    }

    private fun rms(pcm: ByteArray): Float {
        var sum = 0.0
        var n = 0
        var i = 0
        while (i + 1 < pcm.size) {
            val s = ((pcm[i + 1].toInt() shl 8) or (pcm[i].toInt() and 0xff)).toShort() / 32768.0
            sum += s * s
            n++
            i += 2
        }
        return if (n == 0) 0f else (sqrt(sum / n) * 4).toFloat().coerceIn(0f, 1f)
    }
}

private class Mic(private val onChunk: (ByteArray) -> Unit) {
    @Volatile private var running = false

    @SuppressLint("MissingPermission") // RECORD_AUDIO is requested in MainActivity before any session.
    fun start() {
        if (running) return
        running = true
        thread(name = "gbxr-mic") {
            val min = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            val rec = AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION, // echo cancellation for open-ear glasses
                SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, min * 2,
            )
            val buf = ByteArray(SAMPLE_RATE / 10 * 2) // 100 ms
            rec.startRecording()
            try {
                while (running) {
                    val n = rec.read(buf, 0, buf.size)
                    if (n > 0) onChunk(buf.copyOf(n))
                }
            } finally {
                rec.stop()
                rec.release()
            }
        }
    }

    fun stop() {
        running = false
    }
}

private class Speaker {
    private val track = AudioTrack.Builder()
        .setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
        )
        .setAudioFormat(
            AudioFormat.Builder()
                .setSampleRate(SAMPLE_RATE)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .build(),
        )
        .setTransferMode(AudioTrack.MODE_STREAM)
        .build()
        .also { it.play() }

    fun play(pcm: ByteArray) {
        track.write(pcm, 0, pcm.size, AudioTrack.WRITE_NON_BLOCKING)
    }

    fun flush() {
        track.pause()
        track.flush()
        track.play()
    }

    fun release() = runCatching { track.release() }
}
