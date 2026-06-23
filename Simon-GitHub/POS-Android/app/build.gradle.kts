import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    // Kotlin 2.0: Compose Compiler is a separate Kotlin plugin.
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.hilt)
    alias(libs.plugins.ksp)
}

// Read keystore properties for release signing. File is gitignored;
// copy `keystore.properties.template` to `keystore.properties` locally.
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) {
        load(keystorePropertiesFile.inputStream())
    }
}

android {
    namespace = "com.cafe.pos"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.cafe.pos"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables { useSupportLibrary = true }

        // API base URL — read from local.properties or override here.
        // 10.0.2.2 is the Android emulator's loopback to the host machine.
        val apiBase = (project.findProperty("API_BASE_URL") as String?) ?: "http://10.0.2.2:3000/"
        buildConfigField("String", "API_BASE_URL", "\"$apiBase\"")
        buildConfigField("String", "API_BASE_HOST", "\"${apiBase.removeSuffix("/")}\"")
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            // R8 minification is enabled on AGP 8.7+; the earlier CMEx bug
            // was specific to the R8 8.5.x line that shipped with AGP 8.5.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // Pull signing config from keystore.properties; fall back to
            // a debug keystore if the file is absent (dev builds only).
            signingConfig = if (keystorePropertiesFile.exists() &&
                keystoreProperties.getProperty("POS_KEYSTORE_PATH") != null) {
                signingConfigs.create("release") {
                    storeFile = file(keystoreProperties.getProperty("POS_KEYSTORE_PATH"))
                    storePassword = keystoreProperties.getProperty("POS_KEYSTORE_PASSWORD")
                    keyAlias = keystoreProperties.getProperty("POS_KEY_ALIAS")
                    keyPassword = keystoreProperties.getProperty("POS_KEY_PASSWORD")
                }
            } else signingConfigs.getByName("debug")
        }
    }

    lint {
        // Don't block release builds on non-fatal lint warnings during
        // development; the CI job runs lint explicitly. Re-enable for
        // production hardening.
        abortOnError = false
        checkReleaseBuilds = true
        baseline = file("lint-baseline.xml")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
            excludes += "/META-INF/LICENSE*"
            excludes += "/META-INF/NOTICE*"
        }
    }

    // Allow cleartext HTTP for the emulator dev loopback only.
    // Production builds must use https + the manifest network_security_config.
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    // Core / lifecycle
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.splashscreen)
    implementation(libs.material)

    // Compose BOM controls all compose versions
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons.extended)
    implementation(libs.compose.foundation)
    implementation(libs.androidx.navigation.compose)
    debugImplementation(libs.compose.ui.tooling)

    // Hilt
    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.hilt.navigation.compose)

    // Networking
    implementation(libs.retrofit)
    implementation(libs.retrofit.converter.moshi)
    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)
    implementation(libs.moshi)
    implementation(libs.moshi.kotlin)
    implementation(libs.moshi.adapters)

    // Coroutines
    implementation(libs.kotlinx.coroutines.core)
    implementation(libs.kotlinx.coroutines.android)

    // DataStore (auth token persistence)
    implementation(libs.androidx.datastore.preferences)

    // Room (offline cache for menu + pending orders)
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)

    // CameraX + ML Kit (barcode scanner)
    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.mlkit.barcode)

    // USB Serial (ESC/POS receipt printers)
    implementation(libs.usb.serial)

    // WorkManager (periodic background sync) + Hilt integration
    implementation(libs.work.runtime.ktx)
    implementation(libs.work.hilt)
    ksp(libs.work.hilt.compiler)

    // Biometric + Fragment (Phase 4c — biometric unlock + auto-lock)
    implementation(libs.biometric)
    implementation(libs.fragment.ktx)

    // Tests
    testImplementation(libs.junit)
    testImplementation(libs.mockk)
    testImplementation(libs.turbine)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.work.testing)
}