package com.gbxr.app.xr

import android.app.Activity
import android.content.Context
import androidx.xr.arcore.Anchor
import androidx.xr.arcore.AnchorCreateSuccess
import androidx.xr.arcore.ArDevice
import androidx.xr.arcore.hitTest
import androidx.xr.runtime.Config
import androidx.xr.runtime.Session
import androidx.xr.runtime.SessionCreateSuccess
import androidx.xr.runtime.math.Pose
import androidx.xr.runtime.math.Ray
import androidx.xr.runtime.math.Vector3
import androidx.xr.scenecore.AnchorEntity
import androidx.xr.scenecore.GltfModel
import androidx.xr.scenecore.GltfModelEntity
import com.gbxr.core.behavior.BotState
import com.gbxr.core.model.BotProfile
import com.gbxr.core.place.Vec3
import java.nio.file.Paths
import java.util.UUID

/**
 * ⚠️ The only file that uses Jetpack XR (runtime, SceneCore, ARCore for
 * Jetpack XR). Those libraries are pre-release and were not compiled in the
 * environment this was written in. Expect to adjust names (e.g. glTF APIs moved
 * to GltfModelNode in Developer Preview 4) when you open it in Android Studio.
 * The rest of the app only talks to this class, so fixes stay here.
 *
 * Responsibilities:
 *  - start an XR session (or report "not XR" so the app runs in 2D mode)
 *  - place a bot on a surface you're looking at, persist the anchor, restore it
 *  - load each bot's glTF avatar and play the animation for its state
 *  - report head position/direction and anchor positions for the place-bot engine
 */
class XrStage(private val activity: Activity) {
    private lateinit var session: Session
    private val anchors = mutableMapOf<String, Anchor>() // anchorId -> anchor
    private val avatars = mutableMapOf<String, GltfModelEntity>() // botId -> avatar
    private val prefs = activity.getSharedPreferences("gbxr_anchors", Context.MODE_PRIVATE)

    /** False on phones/tablets: the app falls back to the 2D companion screen. */
    fun start(): Boolean {
        val result = runCatching { Session.create(activity) }.getOrNull()
        session = (result as? SessionCreateSuccess)?.session ?: return false
        session.configure(
            session.config.copy(
                planeTracking = Config.PlaneTrackingMode.HORIZONTAL_AND_VERTICAL, // desks and fridge doors
                headTracking = Config.HeadTrackingMode.LAST_KNOWN,
                anchorPersistence = Config.AnchorPersistenceMode.LOCAL,
            ),
        )
        return true
    }

    /** Re-attach bots to the anchors saved last time. Returns botId -> anchorId. */
    suspend fun restore(bots: Map<String, BotProfile>): Map<String, String> {
        val placed = mutableMapOf<String, String>()
        for ((anchorId, botId) in prefs.all) {
            val bot = bots[botId as? String] ?: continue
            val loaded = Anchor.load(session, UUID.fromString(anchorId))
            val anchor = (loaded as? AnchorCreateSuccess)?.anchor ?: continue
            anchors[anchorId] = anchor
            attachAvatar(bot, anchor)
            placed[bot.id] = anchorId
        }
        return placed
    }

    /** Put a bot on the surface the wearer is looking at. Returns the new anchor id. */
    suspend fun placeInFront(bot: BotProfile): String? {
        val head = ArDevice.getInstance(session).state.value.devicePose
        val forward = forwardOf(head)
        val hit = hitTest(session, Ray(head.translation, forward)).firstOrNull()
        val pose = hit?.hitPose ?: Pose(head.translation + forward * 0.6f, head.rotation)
        val anchor = (Anchor.create(session, pose) as? AnchorCreateSuccess)?.anchor ?: return null
        val uuid = anchor.persist()
        val anchorId = uuid.toString()
        anchors[anchorId] = anchor
        prefs.edit().putString(anchorId, bot.id).apply()
        attachAvatar(bot, anchor)
        return anchorId
    }

    fun remove(anchorId: String) {
        anchors.remove(anchorId)?.let { a ->
            runCatching { Anchor.unpersist(session, UUID.fromString(anchorId)) }
            a.detach()
        }
        prefs.edit().remove(anchorId).apply()
    }

    fun play(botId: String, state: BotState) {
        avatars[botId]?.startAnimation(loop = state != BotState.NOTICING, animationName = state.animation)
    }

    /** Lip-sync: 0..1 mouth openness from the bot's voice loudness. */
    fun setMouth(botId: String, level: Float) {
        // Needs a "mouth_open" morph target on the model; wire up once the
        // SceneCore glTF node/morph API settles. Until then, the talk animation covers it.
    }

    fun headPosition(): Vec3 = ArDevice.getInstance(session).state.value.devicePose.translation.toVec3()

    fun gazeDirection(): Vec3 = forwardOf(ArDevice.getInstance(session).state.value.devicePose).toVec3()

    fun anchorPositions(): Map<String, Vec3> = anchors.mapValues { (_, a) -> a.state.value.pose.translation.toVec3() }

    private suspend fun attachAvatar(bot: BotProfile, anchor: Anchor) {
        val model = GltfModel.create(session, Paths.get("avatars", bot.avatar))
        val entity = GltfModelEntity.create(session, model)
        entity.setParent(AnchorEntity.create(session, anchor))
        entity.setScale(0.15f) // desk-sized companions
        avatars[bot.id] = entity
        play(bot.id, BotState.IDLE)
    }

    /** Rotate -Z (forward in OpenXR) by the pose's rotation. */
    private fun forwardOf(p: Pose): Vector3 {
        val q = p.rotation
        val x = -(2 * (q.x * q.z + q.w * q.y))
        val y = -(2 * (q.y * q.z - q.w * q.x))
        val z = -(1 - 2 * (q.x * q.x + q.y * q.y))
        return Vector3(x, y, z)
    }

    private fun Vector3.toVec3() = Vec3(x, y, z)
}
