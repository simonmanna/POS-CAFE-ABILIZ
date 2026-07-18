package com.poscafe.pos.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.googlefonts.Font
import androidx.compose.ui.text.googlefonts.GoogleFont
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.poscafe.pos.R

/**
 * Inter, fetched once through the Google Fonts provider and cached by the OS.
 * If the provider is unavailable (no GMS / fully offline first boot) Compose
 * silently falls back to the platform font — the terminal never blocks on type.
 */
private val fontProvider = GoogleFont.Provider(
    providerAuthority = "com.google.android.gms.fonts",
    providerPackage = "com.google.android.gms",
    certificates = R.array.com_google_android_gms_fonts_certs,
)

private val inter = GoogleFont("Inter")

val InterFamily = FontFamily(
    Font(googleFont = inter, fontProvider = fontProvider, weight = FontWeight.Normal),
    Font(googleFont = inter, fontProvider = fontProvider, weight = FontWeight.Medium),
    Font(googleFont = inter, fontProvider = fontProvider, weight = FontWeight.SemiBold),
    Font(googleFont = inter, fontProvider = fontProvider, weight = FontWeight.Bold),
)

/** Large, glanceable scale — staff read this while moving. */
val PosTypography = Typography(
    displaySmall = TextStyle( // hero money (change due, totals)
        fontFamily = InterFamily, fontWeight = FontWeight.Bold, fontSize = 34.sp, letterSpacing = (-0.02).em,
    ),
    headlineMedium = TextStyle( // screen titles
        fontFamily = InterFamily, fontWeight = FontWeight.SemiBold, fontSize = 26.sp, letterSpacing = (-0.02).em,
    ),
    headlineSmall = TextStyle(
        fontFamily = InterFamily, fontWeight = FontWeight.SemiBold, fontSize = 22.sp, letterSpacing = (-0.01).em,
    ),
    titleLarge = TextStyle( // price emphasis
        fontFamily = InterFamily, fontWeight = FontWeight.Bold, fontSize = 22.sp, letterSpacing = (-0.01).em,
    ),
    titleMedium = TextStyle( // section headers
        fontFamily = InterFamily, fontWeight = FontWeight.Medium, fontSize = 18.sp, letterSpacing = (-0.01).em,
    ),
    titleSmall = TextStyle( // card titles
        fontFamily = InterFamily, fontWeight = FontWeight.SemiBold, fontSize = 16.sp,
    ),
    bodyLarge = TextStyle(
        fontFamily = InterFamily, fontWeight = FontWeight.Normal, fontSize = 16.sp,
    ),
    bodyMedium = TextStyle( // body
        fontFamily = InterFamily, fontWeight = FontWeight.Normal, fontSize = 15.sp,
    ),
    bodySmall = TextStyle(
        fontFamily = InterFamily, fontWeight = FontWeight.Normal, fontSize = 13.sp,
    ),
    labelLarge = TextStyle( // buttons
        fontFamily = InterFamily, fontWeight = FontWeight.SemiBold, fontSize = 16.sp,
    ),
    labelMedium = TextStyle( // captions / badges
        fontFamily = InterFamily, fontWeight = FontWeight.Medium, fontSize = 13.sp,
    ),
    labelSmall = TextStyle(
        fontFamily = InterFamily, fontWeight = FontWeight.Medium, fontSize = 11.sp, letterSpacing = 0.04.em,
    ),
)
