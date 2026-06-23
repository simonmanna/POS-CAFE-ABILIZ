package com.cafe.pos.ui.components.scanner

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.FlashOff
import androidx.compose.material.icons.filled.FlashOn
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.cafe.pos.hardware.impl.CameraBarcodeScanner
import com.cafe.pos.hardware.impl.BarcodeCameraPreview
import kotlinx.coroutines.launch

/**
 * Bottom sheet that opens the camera, shows a live preview with a barcode
 * analyzer, and returns the scanned value to the caller via [onScanned].
 *
 * Usage:
 * ```
 * var showScanner by remember { mutableStateOf(false) }
 * ...
 * ScannerSheet(
 *     visible = showScanner,
 *     scanner = hiltViewModel<...>().scanner,
 *     onScanned = { code -> showScanner = false; ... },
 *     onDismiss = { showScanner = false },
 * )
 * ```
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScannerSheet(
    visible: Boolean,
    scanner: CameraBarcodeScanner,
    onScanned: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    if (!visible) return
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    var torchOn by remember { mutableStateOf(false) }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = MaterialTheme.colorScheme.surface,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .height(540.dp)
                .padding(16.dp),
        ) {
            // Header row
            androidx.compose.foundation.layout.Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Default.QrCodeScanner, contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.size(8.dp))
                Text("Scan barcode", style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f))
                IconButton(onClick = { torchOn = scanner.toggleTorch() ?: torchOn }) {
                    Icon(
                        imageVector = if (torchOn) Icons.Default.FlashOn else Icons.Default.FlashOff,
                        contentDescription = if (torchOn) "Torch on" else "Torch off",
                    )
                }
                IconButton(onClick = {
                    scanner.cancel()
                    onDismiss()
                }) {
                    Icon(Icons.Default.Close, contentDescription = "Close scanner")
                }
            }
            Spacer(Modifier.height(12.dp))

            // Camera preview area
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .background(Color.Black),
                contentAlignment = Alignment.Center,
            ) {
                BarcodeCameraPreview(scanner = scanner)
                Text(
                    "Point the camera at a product barcode",
                    color = Color.White.copy(alpha = 0.8f),
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .padding(24.dp),
                )
            }

            Spacer(Modifier.height(8.dp))

            // Manual entry fallback
            var manual by remember { mutableStateOf("") }
            androidx.compose.foundation.layout.Row(
                verticalAlignment = Alignment.CenterVertically,
            ) {
                androidx.compose.material3.OutlinedTextField(
                    value = manual,
                    onValueChange = { manual = it },
                    placeholder = { Text("Or type SKU…") },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.size(8.dp))
                Button(
                    onClick = {
                        if (manual.isNotBlank()) {
                            scanner.cancel()
                            onScanned(manual.trim())
                        }
                    },
                    enabled = manual.isNotBlank(),
                ) { Text("Add") }
            }
        }

        // Auto-dismiss once a scan completes
        LaunchedEffect(Unit) {
            scope.launch {
                val code = scanner.scan()
                if (!code.isNullOrBlank()) onScanned(code)
            }
        }
    }
}