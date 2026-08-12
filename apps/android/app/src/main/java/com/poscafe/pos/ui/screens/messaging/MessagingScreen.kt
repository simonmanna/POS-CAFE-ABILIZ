@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.poscafe.pos.ui.screens.messaging

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.poscafe.pos.data.local.entity.ConversationEntity
import com.poscafe.pos.data.local.entity.MessageEntity
import com.poscafe.pos.data.repo.AuthRepository
import com.poscafe.pos.data.repo.MessagingRepository
import com.poscafe.pos.data.repo.SyncRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import javax.inject.Inject

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@HiltViewModel
class MessagingViewModel @Inject constructor(
    private val repo: MessagingRepository,
    private val sync: SyncRepository,
    private val auth: AuthRepository,
) : ViewModel() {
    val currentUserId: String get() = auth.current?.userId ?: ""
    private val currentName: String get() = auth.current?.displayName ?: "Me"

    val conversations: StateFlow<List<ConversationEntity>> =
        repo.conversations().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    private val selectedId = MutableStateFlow<String?>(null)
    val selected: StateFlow<String?> = selectedId

    val thread: StateFlow<List<MessageEntity>> =
        selectedId.flatMapLatest { id -> if (id == null) flowOf(emptyList()) else repo.thread(id) }
            .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    fun open(conversationId: String) {
        selectedId.value = conversationId
        refresh()
    }

    fun back() { selectedId.value = null }

    fun send(body: String) {
        val id = selectedId.value ?: return
        if (body.isBlank()) return
        viewModelScope.launch {
            repo.send(id, body.trim(), currentUserId, currentName)
            runCatching { sync.push() } // best-effort immediate flush
        }
    }

    fun retry(messageId: String) {
        viewModelScope.launch {
            repo.retry(messageId, currentUserId)
            runCatching { sync.push() }
        }
    }

    fun markRead() {
        val id = selectedId.value ?: return
        val last = thread.value.lastOrNull()?.id
        viewModelScope.launch { repo.markRead(id, currentUserId, last) }
    }

    /** syncNow — pull the tail + flush the outbox. Safe offline (best-effort). */
    fun refresh() {
        viewModelScope.launch {
            runCatching { sync.pull() }
            runCatching { sync.push() }
        }
    }
}

@Composable
fun MessagingScreen(onBack: () -> Unit, vm: MessagingViewModel = hiltViewModel()) {
    val conversations by vm.conversations.collectAsStateWithLifecycle()
    val selected by vm.selected.collectAsStateWithLifecycle()
    val thread by vm.thread.collectAsStateWithLifecycle()

    // 20s in-screen poll while a conversation is open (no persistent socket in v1).
    LaunchedEffect(selected) {
        if (selected != null) {
            while (true) {
                delay(20_000)
                vm.refresh()
            }
        }
    }
    // Advance the read cursor whenever the open thread changes.
    LaunchedEffect(thread.size, selected) { if (selected != null) vm.markRead() }

    if (selected == null) {
        ConversationList(conversations, onOpen = vm::open, onBack = onBack)
    } else {
        ThreadPane(
            messages = thread,
            currentUserId = vm.currentUserId,
            onBack = vm::back,
            onSend = vm::send,
            onRetry = vm::retry,
        )
    }
}

@Composable
private fun ConversationList(conversations: List<ConversationEntity>, onOpen: (String) -> Unit, onBack: () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text("Messages") },
            navigationIcon = {
                IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
            },
        )
        if (conversations.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("No channels yet", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else {
            LazyColumn(Modifier.fillMaxSize()) {
                items(conversations, key = { it.id }) { c ->
                    ListItem(
                        headlineContent = { Text(c.title, fontWeight = FontWeight.Medium) },
                        supportingContent = { c.lastMessagePreview?.let { Text(it, maxLines = 1) } },
                        modifier = Modifier.fillMaxWidth().clickable { onOpen(c.id) },
                    )
                    HorizontalDivider()
                }
            }
        }
    }
}

@Composable
private fun ThreadPane(
    messages: List<MessageEntity>,
    currentUserId: String,
    onBack: () -> Unit,
    onSend: (String) -> Unit,
    onRetry: (String) -> Unit,
) {
    var draft by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text("Conversation") },
            navigationIcon = {
                IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
            },
        )
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(12.dp)) {
            items(messages, key = { it.id }) { m -> MessageBubble(m, mine = m.direction == "outbound", onRetry = onRetry) }
        }
        Row(
            Modifier.fillMaxWidth().padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("Message…") },
                maxLines = 4,
            )
            Spacer(Modifier.width(8.dp))
            IconButton(
                onClick = { onSend(draft); draft = "" },
                enabled = draft.isNotBlank(),
            ) {
                Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send")
            }
        }
    }
}

@Composable
private fun MessageBubble(m: MessageEntity, mine: Boolean, onRetry: (String) -> Unit) {
    val failed = m.deliveryState == "failed"
    val sending = m.deliveryState == "sending"
    Column(
        Modifier.fillMaxWidth().padding(vertical = 4.dp),
        horizontalAlignment = if (mine) Alignment.End else Alignment.Start,
    ) {
        if (!mine) Text(m.senderName, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
        Surface(
            shape = RoundedCornerShape(14.dp),
            color = when {
                failed -> MaterialTheme.colorScheme.errorContainer
                mine -> MaterialTheme.colorScheme.primaryContainer
                else -> MaterialTheme.colorScheme.surfaceVariant
            },
            modifier = Modifier.alpha(if (sending) 0.6f else 1f).widthIn(max = 300.dp),
        ) {
            Text(m.body, Modifier.padding(horizontal = 12.dp, vertical = 8.dp))
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(timeOf(m.occurredAt), style = MaterialTheme.typography.labelSmall, color = Color.Gray)
            if (mine && sending) {
                Spacer(Modifier.width(4.dp)); Icon(Icons.Filled.Schedule, contentDescription = "Sending", modifier = Modifier.size(12.dp), tint = Color.Gray)
            }
            // 'sent' shows a single tick. delivered/read are intentionally NOT
            // rendered on a shared till (identity switches per PIN).
            if (mine && m.deliveryState == "sent") {
                Spacer(Modifier.width(4.dp)); Icon(Icons.Filled.Check, contentDescription = "Sent", modifier = Modifier.size(12.dp), tint = Color.Gray)
            }
            if (failed) {
                Spacer(Modifier.width(8.dp))
                TextButton(onClick = { onRetry(m.id) }, contentPadding = PaddingValues(0.dp)) { Text("Retry") }
            }
        }
    }
}

private val timeFmt = SimpleDateFormat("HH:mm", Locale.getDefault())
private fun timeOf(epoch: Long): String = timeFmt.format(Date(epoch))
