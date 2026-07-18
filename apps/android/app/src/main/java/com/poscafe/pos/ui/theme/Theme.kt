package com.poscafe.pos.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

val PosShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp), // buttons, inputs
    large = RoundedCornerShape(18.dp), // cards
    extraLarge = RoundedCornerShape(24.dp), // sheets, dialogs
)

private val LightScheme = lightColorScheme(
    primary = PosColors.Green,
    onPrimary = Color.White,
    primaryContainer = PosColors.GreenLight,
    onPrimaryContainer = PosColors.GreenDark,
    secondary = PosColors.TextSecondary,
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFEDF1F5),
    onSecondaryContainer = PosColors.TextPrimary,
    tertiary = PosColors.Purple,
    onTertiary = Color.White,
    tertiaryContainer = PosColors.PurpleSoft,
    onTertiaryContainer = Color(0xFF5B21B6),
    background = PosColors.Background,
    onBackground = PosColors.TextPrimary,
    surface = PosColors.Card,
    onSurface = PosColors.TextPrimary,
    surfaceVariant = Color(0xFFF1F4F7),
    onSurfaceVariant = PosColors.TextSecondary,
    surfaceContainerHighest = Color(0xFFEDF1F5),
    surfaceContainerHigh = Color(0xFFF1F4F7),
    surfaceContainer = Color(0xFFF6F8FA),
    surfaceContainerLow = Color(0xFFFAFBFC),
    surfaceContainerLowest = Color.White,
    outline = PosColors.Border,
    outlineVariant = Color(0xFFEDF0F3),
    error = PosColors.Error,
    onError = Color.White,
    errorContainer = PosColors.ErrorSoft,
    onErrorContainer = Color(0xFF991B1B),
    inverseSurface = PosColors.DarkCard,
    inverseOnSurface = Color.White,
    scrim = Color(0x66111827),
)

private val DarkScheme = darkColorScheme(
    primary = PosColors.Green,
    onPrimary = Color.White,
    primaryContainer = Color(0xFF064E3B),
    onPrimaryContainer = Color(0xFFA7F3D0),
    secondary = PosColors.DarkTextSecondary,
    onSecondary = PosColors.DarkBackground,
    secondaryContainer = PosColors.DarkCardRaised,
    onSecondaryContainer = PosColors.DarkTextPrimary,
    tertiary = PosColors.Purple,
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFF4C1D95),
    onTertiaryContainer = PosColors.PurpleSoft,
    background = PosColors.DarkBackground,
    onBackground = PosColors.DarkTextPrimary,
    surface = PosColors.DarkCard,
    onSurface = PosColors.DarkTextPrimary,
    surfaceVariant = PosColors.DarkCardRaised,
    onSurfaceVariant = PosColors.DarkTextSecondary,
    surfaceContainerHighest = Color(0xFF273245),
    surfaceContainerHigh = PosColors.DarkCardRaised,
    surfaceContainer = Color(0xFF161F30),
    surfaceContainerLow = Color(0xFF101827),
    surfaceContainerLowest = PosColors.DarkBackground,
    outline = PosColors.DarkBorder,
    outlineVariant = Color(0xFF1E293B),
    error = Color(0xFFF87171),
    onError = Color(0xFF450A0A),
    errorContainer = Color(0xFF7F1D1D),
    onErrorContainer = PosColors.ErrorSoft,
    inverseSurface = Color(0xFFF3F4F6),
    inverseOnSurface = PosColors.TextPrimary,
    scrim = Color(0x99000000),
)

/** Semantic accents that don't map onto the M3 scheme. */
data class PosAccents(
    val warning: Color,
    val warningContainer: Color,
    val info: Color,
    val infoContainer: Color,
    val success: Color,
    val successContainer: Color,
)

val LocalPosAccents = staticCompositionLocalOf {
    PosAccents(
        warning = PosColors.Warning,
        warningContainer = PosColors.WarningSoft,
        info = PosColors.Info,
        infoContainer = PosColors.InfoSoft,
        success = PosColors.Green,
        successContainer = PosColors.GreenSoft,
    )
}

@Composable
fun PosTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val accents = if (darkTheme) {
        PosAccents(
            warning = Color(0xFFFBBF24), warningContainer = Color(0xFF78350F),
            info = Color(0xFF60A5FA), infoContainer = Color(0xFF1E3A8A),
            success = Color(0xFF34D399), successContainer = Color(0xFF064E3B),
        )
    } else {
        PosAccents(
            warning = PosColors.Warning, warningContainer = PosColors.WarningSoft,
            info = PosColors.Info, infoContainer = PosColors.InfoSoft,
            success = PosColors.GreenDark, successContainer = PosColors.GreenSoft,
        )
    }
    androidx.compose.runtime.CompositionLocalProvider(LocalPosAccents provides accents) {
        MaterialTheme(
            colorScheme = if (darkTheme) DarkScheme else LightScheme,
            typography = PosTypography,
            shapes = PosShapes,
            content = content,
        )
    }
}
