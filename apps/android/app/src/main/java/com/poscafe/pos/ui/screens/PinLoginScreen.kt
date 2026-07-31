package com.poscafe.pos.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Backspace
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.poscafe.pos.data.local.entity.StaffEntity
import com.poscafe.pos.data.repo.AuthRepository
import com.poscafe.pos.ui.components.pressScale
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.launch
import javax.inject.Inject

/** Offline cashier login: pick your name, punch your PIN. No network needed. */
@HiltViewModel
class PinLoginViewModel @Inject constructor(private val auth: AuthRepository) : ViewModel() {
    var staff by mutableStateOf<List<StaffEntity>>(emptyList()); private set
    var selected by mutableStateOf<StaffEntity?>(null)
    var pin by mutableStateOf("")
    var error by mutableStateOf<String?>(null); private set

    init { viewModelScope.launch { staff = auth.staffList() } }

    fun submit(onLoggedIn: () -> Unit) {
        val user = selected ?: return
        viewModelScope.launch {
            try {
                auth.loginWithPin(user.id, pin).fold(
                    onSuccess = { error = null; pin = ""; onLoggedIn() },
                    onFailure = { error = it.message; pin = "" },
                )
            } catch (t: Throwable) {
                // Last-resort guard: ANY uncaught throw inside the login path
                // (Keystore failure, Room open, Hilt init) would otherwise kill
                // the process via the default uncaught-exception handler.
                error = "Login error: ${t.message ?: t.javaClass.simpleName}"
                pin = ""
            }
        }
    }
}

@Composable
fun PinLoginScreen(onLoggedIn: () -> Unit, vm: PinLoginViewModel = hiltViewModel()) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val wide = maxWidth >= 720.dp
        if (wide) {
            Row(
                Modifier.fillMaxSize().padding(32.dp),
                horizontalArrangement = Arrangement.spacedBy(32.dp),
            ) {
                StaffPicker(vm, Modifier.weight(1f))
                PinPad(vm, onLoggedIn, Modifier.width(300.dp).align(Alignment.CenterVertically))
            }
        } else {
            Column(
                Modifier.fillMaxSize().padding(20.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                StaffPicker(vm, Modifier.weight(1f).fillMaxWidth())
                Spacer(Modifier.height(16.dp))
                PinPad(vm, onLoggedIn, Modifier.widthIn(max = 320.dp))
            }
        }
    }
}

@Composable
private fun StaffPicker(vm: PinLoginViewModel, modifier: Modifier = Modifier) {
    Column(modifier) {
        Text("Who's on the till?", style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(4.dp))
        Text(
            "Tap your name, then enter your PIN.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(20.dp))
        LazyVerticalGrid(
            columns = GridCells.Adaptive(150.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            items(vm.staff, key = { it.id }) { user ->
                val isSel = vm.selected?.id == user.id
                val name = listOfNotNull(user.firstName, user.lastName).joinToString(" ")
                val initials = listOfNotNull(user.firstName.firstOrNull(), user.lastName?.firstOrNull())
                    .joinToString("").uppercase()
                val interaction = remember { MutableInteractionSource() }
                Surface(
                    onClick = { vm.selected = user; vm.pin = "" },
                    interactionSource = interaction,
                    shape = MaterialTheme.shapes.large,
                    color = if (isSel) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.5f) else MaterialTheme.colorScheme.surface,
                    border = BorderStroke(
                        width = if (isSel) 1.5.dp else 1.dp,
                        color = if (isSel) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant,
                    ),
                    shadowElevation = 1.dp,
                    modifier = Modifier.pressScale(interaction),
                ) {
                    Column(
                        Modifier.padding(vertical = 18.dp, horizontal = 12.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Box(
                            Modifier
                                .size(48.dp)
                                .background(
                                    if (isSel) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceContainerHighest,
                                    CircleShape,
                                ),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                initials.ifBlank { "?" },
                                style = MaterialTheme.typography.titleSmall,
                                color = if (isSel) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Text(
                            name,
                            style = MaterialTheme.typography.titleSmall,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun PinPad(vm: PinLoginViewModel, onLoggedIn: () -> Unit, modifier: Modifier = Modifier) {
    val haptics = LocalHapticFeedback.current
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(
            vm.selected?.firstName?.let { "PIN for $it" } ?: "Select your name",
            style = MaterialTheme.typography.titleMedium,
            color = if (vm.selected != null) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
        )
        // PIN dots
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(vertical = 8.dp)) {
            val count = maxOf(4, vm.pin.length)
            repeat(count) { i ->
                Box(
                    Modifier
                        .size(14.dp)
                        .background(
                            color = if (i < vm.pin.length) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceContainerHighest,
                            shape = CircleShape,
                        ),
                )
            }
        }
        vm.error?.let {
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
        }
        val rows = listOf(
            listOf("1", "2", "3"),
            listOf("4", "5", "6"),
            listOf("7", "8", "9"),
            listOf("⌫", "0", "OK"),
        )
        rows.forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                row.forEach { key ->
                    val isOk = key == "OK"
                    val isBack = key == "⌫"
                    val interaction = remember { MutableInteractionSource() }
                    Surface(
                        onClick = {
                            haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                            when {
                                isBack -> vm.pin = vm.pin.dropLast(1)
                                isOk -> vm.submit(onLoggedIn)
                                else -> if (vm.pin.length < 8) vm.pin += key
                            }
                        },
                        interactionSource = interaction,
                        enabled = vm.selected != null,
                        shape = MaterialTheme.shapes.medium,
                        color = when {
                            isOk -> MaterialTheme.colorScheme.primary
                            else -> MaterialTheme.colorScheme.surface
                        },
                        border = if (isOk) null else BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                        shadowElevation = if (isOk) 0.dp else 1.dp,
                        modifier = Modifier.size(width = 88.dp, height = 60.dp).pressScale(interaction),
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            when {
                                isOk -> Icon(Icons.Filled.Check, "Log in", tint = MaterialTheme.colorScheme.onPrimary)
                                isBack -> Icon(
                                    Icons.AutoMirrored.Outlined.Backspace, "Delete",
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.size(20.dp),
                                )
                                else -> Text(
                                    key,
                                    style = MaterialTheme.typography.headlineSmall,
                                    color = if (vm.selected != null) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f),
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
