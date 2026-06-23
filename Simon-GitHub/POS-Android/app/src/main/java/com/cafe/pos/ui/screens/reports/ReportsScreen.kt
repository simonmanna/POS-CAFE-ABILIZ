package com.cafe.pos.ui.screens.reports

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cafe.pos.data.model.HourlyBucket
import com.cafe.pos.data.model.TopItemRow
import com.cafe.pos.data.model.XReport
import com.cafe.pos.data.repository.PosRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.LocalDate
import javax.inject.Inject

data class ReportsUiState(
    val xReport: XReport? = null,
    val hourly: List<HourlyBucket> = emptyList(),
    val topItems: List<TopItemRow> = emptyList(),
    val error: String? = null,
    val loading: Boolean = false,
)

@HiltViewModel
class ReportsViewModel @Inject constructor(
    private val posRepository: PosRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(ReportsUiState())
    val state: StateFlow<ReportsUiState> = _state.asStateFlow()

    init { load() }

    fun load() {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            try {
                val x = posRepository.xReport()
                val today = LocalDate.now().toString()
                val hourly = posRepository.salesByHour(today)
                val top = posRepository.topItems(today, today)
                _state.update { it.copy(loading = false, xReport = x, hourly = hourly.buckets, topItems = top) }
            } catch (t: Throwable) {
                _state.update { it.copy(loading = false, error = t.message) }
            }
        }
    }

    fun zClose() {
        viewModelScope.launch {
            try {
                val z = posRepository.zReport()
                _state.update { it.copy(xReport = z) }
            } catch (t: Throwable) {
                _state.update { it.copy(error = t.message) }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReportsScreen(
    viewModel: ReportsViewModel = hiltViewModel(),
    onBack: () -> Unit,
) {
    val state by viewModel.state.collectAsState()
    var tab by remember { mutableIntStateOf(0) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Reports") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    titleContentColor = MaterialTheme.colorScheme.onPrimary,
                    navigationIconContentColor = MaterialTheme.colorScheme.onPrimary,
                ),
            )
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            TabRow(selectedTabIndex = tab) {
                listOf("X-Report", "Hourly", "Top items").forEachIndexed { i, title ->
                    Tab(selected = tab == i, onClick = { tab = i }, text = { Text(title) })
                }
            }
            when (tab) {
                0 -> XReportView(state, onZ = viewModel::zClose)
                1 -> HourlyView(state.hourly)
                2 -> TopItemsView(state.topItems)
            }
        }
    }
}

@Composable
private fun XReportView(state: ReportsUiState, onZ: () -> Unit) {
    val r = state.xReport
    Column(modifier = Modifier.padding(16.dp).fillMaxSize()) {
        if (r == null) { Text("No data"); return }
        Card(modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("Shift as of ${r.asOf}", style = MaterialTheme.typography.titleMedium)
                HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text("Sales"); Text("K${r.totals.salesTotal}") }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text("Refunds"); Text("-K${r.totals.refundsTotal}") }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text("Net sales"); Text("K${r.totals.netSales}", style = MaterialTheme.typography.titleMedium) }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text("Expected cash"); Text("K${r.totals.expectedCash}") }
            }
        }
        Spacer(Modifier.height(16.dp))
        Card(modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("By method", style = MaterialTheme.typography.titleSmall)
                r.byMethod.forEach { m ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("${m.method} (${m.count})"); Text("K${m.total}")
                    }
                }
            }
        }
        Spacer(Modifier.height(16.dp))
        androidx.compose.material3.OutlinedButton(onClick = onZ, modifier = Modifier.fillMaxWidth()) {
            Text("Close shift (Z-Report)")
        }
    }
}

@Composable
private fun HourlyView(buckets: List<HourlyBucket>) {
    if (buckets.isEmpty()) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text("No sales yet today") }
        return
    }
    LazyColumn(modifier = Modifier.padding(16.dp)) {
        items(buckets, key = { it.hour }) { b ->
            Card(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                Row(modifier = Modifier.padding(12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("%02d:00".format(b.hour))
                    Text("${b.count} sale(s)")
                    Text("K${b.total}")
                }
            }
        }
    }
}

@Composable
private fun TopItemsView(items: List<TopItemRow>) {
    if (items.isEmpty()) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text("No items sold today") }
        return
    }
    LazyColumn(modifier = Modifier.padding(16.dp)) {
        items(items, key = { it.productId }) { item ->
            Card(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                Row(modifier = Modifier.padding(12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(item.name)
                    Text("${item.quantity.toInt()} ×")
                    Text("K${item.total}")
                }
            }
        }
    }
}