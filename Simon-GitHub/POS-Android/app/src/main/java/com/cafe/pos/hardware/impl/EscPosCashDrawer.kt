package com.cafe.pos.hardware.impl

import com.cafe.pos.hardware.CashDrawer
import com.cafe.pos.hardware.PrinterManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Real cash-drawer driver. Cash drawers are passive — they get kicked by the
 * receipt printer via the RJ11/RJ12 port. The ESC/POS spec defines a pulse
 * command (`ESC p`) that most printers honor; we just send it through whichever
 * [PrinterManager] is currently active.
 *
 * If no printer is connected, the kick silently no-ops (and `open()` returns
 * false so the UI can warn the cashier).
 */
@Singleton
class EscPosCashDrawer @Inject constructor(
    private val printer: PrinterManager,
) : CashDrawer {

    override suspend fun open(): Boolean = withContext(Dispatchers.IO) {
        if (!printer.isConnected()) return@withContext false
        printer.openCashDrawer()
    }
}