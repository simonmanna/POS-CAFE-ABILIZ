package com.cafe.pos.ui.screens.checkout

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel

private val PAYMENT_METHODS = listOf("cash", "card", "bank", "mobile_money", "store_credit")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CheckoutScreen(
    viewModel: CheckoutViewModel = hiltViewModel(),
    onDone: (String) -> Unit,
    onBack: () -> Unit,
) {
    val cart by viewModel.cartState.collectAsState()
    val state by viewModel.state.collectAsState()

    val subtotal = cart.lines.sumOf { it.quantity * it.unitPrice * (1 - it.discountPercent / 100.0) }
    val txDiscount = subtotal * (cart.transactionDiscountPercent / 100.0)
    val total = (subtotal - txDiscount).coerceAtLeast(0.0)
    val tendered = state.amountTendered.toDoubleOrNull() ?: 0.0
    val change = if (state.paymentMethod == "cash") (tendered - total).coerceAtLeast(0.0) else 0.0

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Checkout") },
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
        Column(modifier = Modifier.padding(padding).fillMaxSize().padding(16.dp)) {

            Surface(tonalElevation = 2.dp, shape = MaterialTheme.shapes.medium) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text("Order summary", style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(8.dp))
                    cart.lines.forEach { line ->
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("${line.name} × ${line.quantity.toInt()}", modifier = Modifier.weight(1f))
                            Text("K%.2f".format(line.quantity * line.unitPrice * (1 - line.discountPercent / 100.0)))
                        }
                    }
                    HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("Subtotal"); Text("K%.2f".format(subtotal))
                    }
                    if (txDiscount > 0) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("Discount"); Text("-K%.2f".format(txDiscount))
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("Total", style = MaterialTheme.typography.titleMedium)
                        Text("K%.2f".format(total), style = MaterialTheme.typography.titleMedium)
                    }
                }
            }

            Spacer(Modifier.height(16.dp))

            Text("Payment method", style = MaterialTheme.typography.titleMedium)
            Row(modifier = Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PAYMENT_METHODS.forEach { m ->
                    FilterChip(
                        selected = state.paymentMethod == m,
                        onClick = { viewModel.setMethod(m) },
                        label = { Text(m.replace('_', ' ').replaceFirstChar { it.uppercase() }) },
                    )
                }
            }

            Spacer(Modifier.height(16.dp))

            if (state.paymentMethod == "cash") {
                OutlinedTextField(
                    value = state.amountTendered,
                    onValueChange = viewModel::setTendered,
                    label = { Text("Amount tendered") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(modifier = Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("Change"); Text("K%.2f".format(change))
                }
            }

            state.error?.let {
                Spacer(Modifier.height(8.dp))
                Text(it, color = MaterialTheme.colorScheme.error)
            }
            state.printStatus?.let {
                Spacer(Modifier.height(4.dp))
                Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall)
            }

            Spacer(Modifier.weight(1f))

            Button(
                onClick = { viewModel.checkout(onDone) },
                enabled = !state.isSubmitting && cart.lines.isNotEmpty(),
                modifier = Modifier.fillMaxWidth().height(64.dp),
            ) {
                if (state.isSubmitting) CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
                else Text("Pay  K%.2f".format(total), style = MaterialTheme.typography.titleMedium)
            }
        }
    }
}