package com.poscafe.pos.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.outlined.TableRestaurant
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.poscafe.pos.data.local.entity.PosTableEntity
import com.poscafe.pos.ui.components.EmptyState
import com.poscafe.pos.ui.components.StatusDot
import com.poscafe.pos.ui.components.StatusPill
import com.poscafe.pos.ui.components.pressScale

/**
 * Floor view. Table statuses are the last-synced server truth (read-only on
 * the device); picking a table starts a dine-in order on the Sell tab.
 */
@Composable
fun TablesScreen(vm: TerminalViewModel, onTableChosen: () -> Unit, onMenu: (() -> Unit)? = null) {
    val tables by vm.tables.collectAsStateWithLifecycle()
    val selected by vm.selectedTable.collectAsStateWithLifecycle()

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Row(
            Modifier.fillMaxWidth().padding(vertical = 12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                onMenu?.let {
                    IconButton(onClick = it) { Icon(Icons.Filled.Menu, "Menu") }
                }
                Text("Tables", style = MaterialTheme.typography.headlineSmall)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                LegendDot("Available", MaterialTheme.colorScheme.primary)
                LegendDot("Occupied", MaterialTheme.colorScheme.error)
                LegendDot("Reserved", com.poscafe.pos.ui.theme.LocalPosAccents.current.warning)
            }
        }
        if (tables.isEmpty()) {
            EmptyState(
                icon = Icons.Outlined.TableRestaurant,
                title = "No tables synced",
                subtitle = "Tables set up in the back office appear here after a sync.",
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            LazyVerticalGrid(
                columns = GridCells.Adaptive(150.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                contentPadding = PaddingValues(bottom = 16.dp),
            ) {
                items(tables, key = { it.id }) { table ->
                    TableCard(
                        table = table,
                        selected = selected?.id == table.id,
                        onClick = {
                            vm.selectedTable.value = table
                            onTableChosen()
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun LegendDot(label: String, color: androidx.compose.ui.graphics.Color) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        StatusDot(color)
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun TableCard(table: PosTableEntity, selected: Boolean, onClick: () -> Unit) {
    val statusColor = tableStatusColor(table.status)
    val statusLabel = table.status.replace('_', ' ').replaceFirstChar { it.uppercase() }
    val interaction = remember { MutableInteractionSource() }
    Surface(
        onClick = onClick,
        interactionSource = interaction,
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surface,
        shadowElevation = 1.dp,
        border = BorderStroke(
            width = if (selected) 1.5.dp else 1.dp,
            color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant,
        ),
        modifier = Modifier.pressScale(interaction),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Table ${table.number}", style = MaterialTheme.typography.titleSmall)
                StatusDot(statusColor, size = 10.dp)
            }
            table.name?.takeIf { it.isNotBlank() }?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            } ?: Box(Modifier.height(2.dp).alpha(0f))
            StatusPill(statusLabel, color = statusColor, container = statusColor.copy(alpha = 0.12f))
        }
    }
}
