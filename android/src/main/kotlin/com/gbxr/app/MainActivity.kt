package com.gbxr.app

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Bundle
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.MaterialTheme
import androidx.core.app.NotificationCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.gbxr.app.audio.AndroidVoiceConnector
import com.gbxr.app.camera.CameraXFrames
import com.gbxr.app.camera.SceneChangeMeter
import com.gbxr.app.data.DevAuthSession
import com.gbxr.app.ui.CompanionScreen
import com.gbxr.app.ui.CrewState
import com.gbxr.app.xr.XrPanel
import com.gbxr.app.xr.XrStage
import com.gbxr.core.api.GbxrBackend
import com.gbxr.core.care.Medication
import com.gbxr.core.care.MedicationSchedule
import com.gbxr.core.director.BotDirector
import com.gbxr.core.director.CompanionNotifier
import com.gbxr.core.model.BotProfile
import com.gbxr.core.place.SensorFrame
import com.gbxr.core.place.Vec3
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import java.time.LocalDateTime
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class MainActivity : ComponentActivity() {

    private val http = OkHttpClient.Builder().readTimeout(60, TimeUnit.SECONDS).build()
    private val auth = DevAuthSession() // TODO: Supabase Auth (see data/AuthSession.kt)
    private val backend by lazy { GbxrBackend(BuildConfig.BACKEND_URL, http, auth::token) }
    private val crew = CrewState()
    @Volatile private var meds: List<Medication> = emptyList()

    private lateinit var bots: List<BotProfile>
    private lateinit var director: BotDirector
    private var xr: XrStage? = null

    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { start() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        bots = assets.list("bots").orEmpty().filter { it.endsWith(".json") }
            .map { BotProfile.parse(assets.open("bots/$it").bufferedReader().readText()) }
            .sortedBy { it.placement == null } // place bots first
        permissions.launch(arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA, Manifest.permission.POST_NOTIFICATIONS))
    }

    private fun start() {
        val voice = AndroidVoiceConnector(http) { botId, level ->
            crew.mouth[botId] = level
            xr?.setMouth(botId, level)
        }
        director = BotDirector(
            bots = bots,
            backend = backend,
            camera = CameraXFrames(this, this),
            stage = crew,
            voice = voice,
            companion = phoneNotifier(),
            io = Executors.newCachedThreadPool(),
            medsReminder = { now ->
                val schedule = MedicationSchedule(meds)
                schedule.reminderLine(schedule.dueNow(now, emptyList()))
            },
        )

        val stage = XrStage(this).takeIf { it.start() }
        xr = stage
        val meter = if (stage != null) SceneChangeMeter(this, this) else null
        crew.onStateChanged = { id, state -> stage?.play(id, state) }

        // Phone/tablet mode has no room anchors, but scheduled bots (pills,
        // exercise, check-ins) still need to run.
        if (stage == null) {
            bots.filter { b -> b.placement?.triggers?.any { it is com.gbxr.core.model.TriggerSpec.Schedule } == true }
                .forEach { director.placeBot(it.id, "companion:${it.id}") }
        }

        lifecycleScope.launch {
            meds = withContext(Dispatchers.IO) { runCatching { backend.medications() }.getOrDefault(emptyList()) }
            stage?.restore(bots.associateBy { it.id })?.forEach { (botId, anchorId) -> director.placeBot(botId, anchorId) }
        }

        // ~10 Hz sensor loop while the app is in front of the wearer.
        if (stage != null) lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.RESUMED) {
                while (isActive) {
                    director.onFrame(
                        SensorFrame(
                            now = LocalDateTime.now(),
                            elapsedMillis = SystemClock.elapsedRealtime(),
                            headPosition = stage.headPosition(),
                            gazeDirection = stage.gazeDirection(),
                            anchors = stage.anchorPositions(),
                            sceneChange = meter?.level ?: 0f,
                            worn = true,
                        ),
                    )
                    delay(100)
                }
            }
        }

        // Schedules (pills at 8am) keep running when the headset loop isn't.
        // Open on a tablet = present (the bot talks); closed = phone notification.
        // TODO: move to AlarmManager/WorkManager so reminders survive the app being killed.
        lifecycleScope.launch {
            while (isActive) {
                val resumed = lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
                if (stage == null || !resumed) {
                    director.onFrame(
                        SensorFrame(
                            LocalDateTime.now(), SystemClock.elapsedRealtime(), Vec3(0f, 0f, 0f), Vec3(0f, 0f, -1f),
                            emptyMap(), worn = stage == null && resumed,
                        ),
                    )
                }
                delay(30_000)
            }
        }

        // Finished tasks, sale alerts, links sent to the phone.
        lifecycleScope.launch {
            while (isActive) {
                director.checkNotifications()
                delay(30_000)
            }
        }

        setContent {
            MaterialTheme {
                val screen = @androidx.compose.runtime.Composable {
                    CompanionScreen(
                        bots = bots,
                        crew = crew,
                        onTalk = director::summon,
                        onDone = director::dismiss,
                        onPlace = stage?.let { s ->
                            { botId: String ->
                                lifecycleScope.launch {
                                    s.placeInFront(bots.first { it.id == botId })?.let { director.placeBot(botId, it) }
                                }
                                Unit
                            }
                        },
                    )
                }
                if (stage != null) XrPanel(screen) else screen()
            }
        }
    }

    private fun phoneNotifier(): CompanionNotifier {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("bots", "Bot reminders", NotificationManager.IMPORTANCE_HIGH))
        return CompanionNotifier { bot, text ->
            nm.notify(
                bot.id.hashCode(),
                NotificationCompat.Builder(this, "bots")
                    .setSmallIcon(android.R.drawable.ic_dialog_info)
                    .setContentTitle(bot.name)
                    .setContentText(text)
                    .setStyle(NotificationCompat.BigTextStyle().bigText(text))
                    .setAutoCancel(true)
                    .build(),
            )
        }
    }
}
