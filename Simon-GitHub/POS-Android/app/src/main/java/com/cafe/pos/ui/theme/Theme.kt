package com.cafe.pos.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

private val Espresso = Color(0xFF3B2418)
private val Amber = Color(0xFFD6A95C)
private val Cream = Color(0xFFF5E9D4)
private val Charcoal = Color(0xFF1F1B16)
private val CharcoalRaised = Color(0xFF26211B)
private val AmberDim = Color(0xFFB88B45)
private val ErrorDark = Color(0xFFEF5350)
private val CreamOnDark = Color(0xFFF5E9D4)

private val LightColors = lightColorScheme(
    primary = Espresso,
    onPrimary = Cream,
    secondary = Amber,
    onSecondary = Espresso,
    background = Cream,
    onBackground = Espresso,
    surface = Color.White,
    onSurface = Espresso,
    surfaceVariant = Cream,
    onSurfaceVariant = Espresso,
    error = Color(0xFFC62828),
    onError = Color.White,
)

private val DarkColors = darkColorScheme(
    primary = Amber,
    onPrimary = Charcoal,
    secondary = Amber,
    onSecondary = Charcoal,
    background = Charcoal,
    onBackground = Cream,
    surface = CharcoalRaised,
    onSurface = Cream,
    surfaceVariant = CharcoalRaised,
    onSurfaceVariant = Cream,
    error = ErrorDark,
    onError = Charcoal,
)

private val PosTypography = Typography(
    displayLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 40.sp),
    displayMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 32.sp),
    displaySmall = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 28.sp),
    headlineLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 24.sp),
    headlineMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 20.sp),
    headlineSmall = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 18.sp),
    titleLarge = TextStyle(fontWeight = FontWeight.Medium, fontSize = 18.sp),
    titleMedium = TextStyle(fontWeight = FontWeight.Medium, fontSize = 16.sp),
    titleSmall = TextStyle(fontWeight = FontWeight.Medium, fontSize = 14.sp),
    bodyLarge = TextStyle(fontSize = 16.sp),
    bodyMedium = TextStyle(fontSize = 14.sp),
    bodySmall = TextStyle(fontSize = 12.sp),
    labelLarge = TextStyle(fontWeight = FontWeight.Medium, fontSize = 16.sp),
    labelMedium = TextStyle(fontWeight = FontWeight.Medium, fontSize = 14.sp),
    labelSmall = TextStyle(fontWeight = FontWeight.Medium, fontSize = 12.sp),
)

@Composable
fun CafePosTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = PosTypography,
        content = content,
    )
}