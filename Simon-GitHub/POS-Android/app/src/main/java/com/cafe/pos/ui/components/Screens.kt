package com.cafe.pos.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
fun LoadingScreen(text: String = "Loading…") {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        androidx.compose.foundation.layout.Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(12.dp),
        ) {
            CircularProgressIndicator()
            Text(text, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
fun ErrorScreen(message: String, onRetry: (() -> Unit)? = null) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        androidx.compose.foundation.layout.Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(12.dp),
        ) {
            Text(message, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.error)
            if (onRetry != null) {
                androidx.compose.material3.TextButton(onClick = onRetry) { Text("Retry") }
            }
        }
    }
}