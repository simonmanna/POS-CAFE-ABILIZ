package com.cafe.pos.ui.navigation

/**
 * Type-safe destination routes. The terminal is the entry point after login.
 * Tablet-optimized layout uses [CafePosNavHost] which switches between single-pane
 * (phone-size) and master-detail (tablet-size) based on window width.
 */
object Routes {
    const val LOGIN = "login"
    const val LOGIN_MFA = "login/mfa"
    const val TERMINAL = "terminal"
    const val CHECKOUT = "checkout"
    const val HOLDS = "holds"
    const val KDS = "kds"
    const val REPORTS = "reports"
    const val RECEIPTS = "receipts/{invoiceId}"
    const val SETTINGS = "settings"
    const val CUSTOMER = "customer"

    fun receipt(invoiceId: String) = "receipts/$invoiceId"
}