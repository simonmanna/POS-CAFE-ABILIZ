package com.cafe.pos.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/** Sticky banner shown when the terminal has no network. */
@Composable
fun OfflineBanner(visible: Boolean, modifier: Modifier = Modifier) {
    if (!visible) return
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.errorContainer)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(Icons.Default.WifiOff, contentDescription = null, tint = MaterialTheme.colorScheme.onErrorContainer)
        Text(
            text = "Offline — orders will sync when reconnected",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onErrorContainer,
        )
    }
}

/** Round badge with a number — used for cart count, KDS new tickets, etc. */
@Composable
fun CountBadge(count: Int, modifier: Modifier = Modifier, color: Color = MaterialTheme.colorScheme.primary) {
    if (count <= 0) return
    Box(
        modifier = modifier
            .size(24.dp)
            .background(color, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = if (count > 99) "99+" else count.toString(),
            color = MaterialTheme.colorScheme.onPrimary,
            style = MaterialTheme.typography.labelSmall,
        )
    }
}

/** Standard top bar height for terminals (tablet-friendly tall bar). */
val TerminalTopBarHeight = 64.dp
val TerminalActionBarHeight = 56.dp

/** Default screen padding. */
val ScreenPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp)