package com.gbxr.app.camera

import android.content.Context
import android.util.Size
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import java.util.concurrent.Executors
import kotlin.math.abs

/**
 * How much the view changed since the last check (0..1), e.g. a fridge door
 * swinging open. Uses a tiny grayscale thumbnail a few times a second; the
 * pixels are compared on-device and immediately discarded — nothing is stored
 * or uploaded. Real photos are only taken when a bot wakes.
 */
class SceneChangeMeter(context: Context, owner: LifecycleOwner) {
    @Volatile var level: Float = 0f
        private set

    private var previous: ByteArray? = null
    private var lastAt = 0L

    init {
        val analysis = ImageAnalysis.Builder()
            .setResolutionSelector(
                ResolutionSelector.Builder()
                    .setResolutionStrategy(ResolutionStrategy(Size(160, 120), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER))
                    .build(),
            )
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()
        analysis.setAnalyzer(Executors.newSingleThreadExecutor()) { image ->
            image.use {
                val now = System.currentTimeMillis()
                if (now - lastAt < 300) return@use
                lastAt = now
                val plane = it.planes[0].buffer
                val step = maxOf(1, plane.remaining() / 2048)
                val sample = ByteArray(plane.remaining() / step) { i -> plane.get(i * step) }
                val prev = previous
                level = if (prev == null || prev.size != sample.size) 0f
                else sample.indices.sumOf { i -> abs((sample[i].toInt() and 0xff) - (prev[i].toInt() and 0xff)) }
                    .toFloat() / (sample.size * 255f) * 4f
                previous = sample
            }
        }
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            future.get().bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, analysis)
        }, ContextCompat.getMainExecutor(context))
    }
}
