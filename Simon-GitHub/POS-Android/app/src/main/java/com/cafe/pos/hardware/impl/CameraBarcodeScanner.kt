package com.cafe.pos.hardware.impl

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.annotation.OptIn
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.cafe.pos.hardware.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * CameraX-powered barcode scanner. Supports torch toggle and haptic feedback
 * on a successful decode. The torch state is exposed via [toggleTorch] so the
 * UI can render a button; the scanner itself only does the camera work.
 *
 * Supported formats: EAN-13, EAN-8, UPC-A, UPC-E, Code 128, QR.
 */
class CameraBarcodeScanner(
    private val context: Context,
) : BarcodeScanner {

    @Volatile private var pending: kotlinx.coroutines.CompletableDeferred<String?>? = null
    @Volatile private var cancelled: Boolean = false

    /** Cached camera control. Bound by [BarcodeCameraPreview] when the UI is shown. */
    internal var camera: Camera? = null

    private val vibrator: Vibrator? by lazy {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)
                ?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    }

    override suspend fun scan(): String? {
        if (cancelled) { cancelled = false; return null }
        val d = kotlinx.coroutines.CompletableDeferred<String?>()
        pending = d
        return d.await()
    }

    override fun cancel() {
        cancelled = true
        pending?.complete(null)
        pending = null
    }

    /** Toggle the torch. Returns the new state, or null if torch isn't available. */
    fun toggleTorch(): Boolean? {
        val cam = camera ?: return null
        if (cam.cameraInfo.hasFlashUnit()) {
            val current = cam.cameraInfo.torchState.value == 1
            cam.cameraControl.enableTorch(!current)
            return !current
        }
        return null
    }

    /** Called by the analyzer when a barcode is detected. */
    internal fun onBarcode(value: String) {
        // Haptic: short, distinct from button taps.
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator?.vibrate(VibrationEffect.createOneShot(60, VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                @Suppress("DEPRECATION")
                vibrator?.vibrate(60)
            }
        } catch (_: SecurityException) {
            // VIBRATE permission missing in some OEM-restricted builds; not fatal.
        }
        pending?.complete(value)
        pending = null
    }
}

/**
 * Composable that renders the live camera preview with a barcode analyzer
 * attached. On a successful decode, [CameraBarcodeScanner.onBarcode] is called
 * exactly once and the composable is expected to be removed from the tree.
 */
@OptIn(ExperimentalGetImage::class)
@Composable
fun BarcodeCameraPreview(
    scanner: CameraBarcodeScanner,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val previewView = remember { PreviewView(context) }
    val cameraExecutor = remember { Executors.newSingleThreadExecutor() }

    val mlKitScanner = remember {
        BarcodeScanning.getClient(
            BarcodeScannerOptions.Builder()
                .setBarcodeFormats(
                    Barcode.FORMAT_EAN_13, Barcode.FORMAT_EAN_8,
                    Barcode.FORMAT_UPC_A, Barcode.FORMAT_UPC_E,
                    Barcode.FORMAT_CODE_128, Barcode.FORMAT_QR_CODE,
                )
                .build()
        )
    }

    DisposableEffect(Unit) {
        onDispose {
            cameraExecutor.shutdown()
            mlKitScanner.close()
            scanner.camera = null
        }
    }

    LaunchedEffect(previewView) {
        val provider = ProcessCameraProvider.getInstance(context).get()
        val preview = Preview.Builder().build().apply {
            setSurfaceProvider(previewView.surfaceProvider)
        }
        val analysis = ImageAnalysis.Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()
        analysis.setAnalyzer(cameraExecutor) { proxy: ImageProxy ->
            val media = proxy.image
            if (media == null) { proxy.close(); return@setAnalyzer }
            val rotation = proxy.imageInfo.rotationDegrees
            val image = InputImage.fromMediaImage(media, rotation)
            mlKitScanner.process(image)
                .addOnSuccessListener { barcodes ->
                    barcodes.firstOrNull()?.rawValue?.let { value -> scanner.onBarcode(value) }
                }
                .addOnCompleteListener { proxy.close() }
        }
        try {
            provider.unbindAll()
            val cam = provider.bindToLifecycle(
                lifecycleOwner as LifecycleOwner,
                CameraSelector.DEFAULT_BACK_CAMERA,
                preview, analysis,
            )
            scanner.camera = cam
            // One-shot AF+AE on the center of the preview so the cashier isn't
            // waiting for the camera to hunt focus. Uses the PreviewView's
            // built-in metering-point factory so coords map correctly regardless
            // of display orientation.
            try {
                val factory = previewView.meteringPointFactory
                val center = factory.createPoint(previewView.width / 2f, previewView.height / 2f)
                val action = FocusMeteringAction.Builder(center, FocusMeteringAction.FLAG_AF)
                    .addPoint(center, FocusMeteringAction.FLAG_AE)
                    .build()
                cam.cameraControl.startFocusAndMetering(action)
            } catch (_: Throwable) { /* no-op */ }
        } catch (e: Exception) {
            // Camera unavailable (no permission, no hardware). Caller surfaces an error.
        }
    }

    AndroidView(factory = { previewView }, modifier = modifier.fillMaxSize())
}