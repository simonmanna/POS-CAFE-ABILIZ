package com.poscafe.pos.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * POS Cafe brand palette — premium SaaS aesthetic (Square/Stripe/Shopify),
 * not stock Material. One green, calm neutrals, high contrast for glanceable
 * reading across a counter.
 */
object PosColors {
    // Brand
    val Green = Color(0xFF0E9F6E)
    val GreenDark = Color(0xFF0B8459)
    val GreenLight = Color(0xFFD1FAE5)
    val GreenSoft = Color(0xFFECFDF5)

    // Light neutrals
    val Background = Color(0xFFF6F8FA)
    val Card = Color(0xFFFFFFFF)
    val Border = Color(0xFFE5E7EB)
    val TextPrimary = Color(0xFF111827)
    val TextSecondary = Color(0xFF6B7280)
    val TextTertiary = Color(0xFF9CA3AF)

    // Dark neutrals
    val DarkBackground = Color(0xFF0B1220)
    val DarkCard = Color(0xFF111827)
    val DarkCardRaised = Color(0xFF1F2937)
    val DarkBorder = Color(0xFF2B3648)
    val DarkTextPrimary = Color(0xFFF9FAFB)
    val DarkTextSecondary = Color(0xFF9CA3AF)

    // Semantic
    val Error = Color(0xFFEF4444)
    val ErrorSoft = Color(0xFFFEE2E2)
    val Warning = Color(0xFFF59E0B)
    val WarningSoft = Color(0xFFFEF3C7)
    val Info = Color(0xFF3B82F6)
    val InfoSoft = Color(0xFFDBEAFE)
    val Purple = Color(0xFF8B5CF6)
    val PurpleSoft = Color(0xFFEDE9FE)

    // Table / order status
    val StatusAvailable = Green
    val StatusOccupied = Error
    val StatusReserved = Warning
    val StatusNeedsBill = Purple
}
