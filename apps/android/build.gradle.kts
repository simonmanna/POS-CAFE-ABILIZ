// Root build file — plugin versions only; module config lives in app/build.gradle.kts.
// Toolchain: Gradle 8.13 + AGP 8.7 + Kotlin 2.0.21, built with JDK 21 (Android Studio's JBR).
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
    id("com.google.devtools.ksp") version "2.0.21-1.0.25" apply false
    id("com.google.dagger.hilt.android") version "2.52" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.0.21" apply false
}
