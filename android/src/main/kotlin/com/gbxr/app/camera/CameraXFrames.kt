package com.gbxr.app.camera

import android.content.Context
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.gbxr.core.director.CameraFrames
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Still captures from the world-facing camera (headset) or the phone's back
 * camera (companion mode). Android XR maps the world-facing camera to the
 * "back" camera once the user grants CAMERA permission. On glasses the
 * permission prompt appears on the paired phone.
 *
 * Frames are only taken when a place bot wakes, never continuously, and the
 * bot shows its "looking" animation while it happens.
 */
class CameraXFrames(context: Context, owner: LifecycleOwner) : CameraFrames {
    private val capture = ImageCapture.Builder()
        .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
        .setJpegQuality(80)
        .build()
    private val executor = ContextCompat.getMainExecutor(context)

    init {
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            future.get().bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, capture)
        }, executor)
    }

    /** Blocking; call off the main thread. */
    override fun capture(count: Int): List<ByteArray> = (0 until count).mapNotNull {
        val latch = CountDownLatch(1)
        var jpeg: ByteArray? = null
        capture.takePicture(executor, object : ImageCapture.OnImageCapturedCallback() {
            override fun onCaptureSuccess(image: ImageProxy) {
                image.use {
                    val buffer = it.planes[0].buffer
                    jpeg = ByteArray(buffer.remaining()).also(buffer::get)
                }
                latch.countDown()
            }
            override fun onError(exception: ImageCaptureException) = latch.countDown()
        })
        latch.await(3, TimeUnit.SECONDS)
        if (it < count - 1) Thread.sleep(250) // a second angle as the door swings
        jpeg
    }
}
