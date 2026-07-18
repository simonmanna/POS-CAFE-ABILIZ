pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // SQLCipher for Android (encrypted Room database).
        maven("https://jitpack.io")
    }
}

rootProject.name = "pos-cafe-android"
include(":app")
