# =============================================================================
# POS-Android R8/ProGuard rules.
#
# R8 in release mode (isMinifyEnabled = true) shrinks and obfuscates the
# bytecode. The rules below preserve the reflection-based paths we rely on:
# Retrofit interfaces, Moshi DTOs, Hilt-generated entry points, Room schema,
# and the WorkManager worker classes.
# =============================================================================

# --- Attributes needed by Retrofit / Moshi / Hilt / Room --------------
-keepattributes Signature, InnerClasses, EnclosingMethod
-keepattributes RuntimeVisibleAnnotations, RuntimeVisibleParameterAnnotations
-keepattributes AnnotationDefault

# --- Retrofit ---------------------------------------------------------
-keep,allowobfuscation,allowshrinking interface retrofit2.Call
-keep,allowobfuscation,allowshrinking class retrofit2.Response
-keep,allowobfuscation,allowshrinking class kotlin.coroutines.Continuation
-dontwarn retrofit2.**
-dontwarn org.codehaus.mojo.animal_sniffer.IgnoreJRERequirement

# Moshi uses reflection for the @JsonClass(generateAdapter=false) and
# KotlinJsonAdapterFactory. We mark every DTO so the reflection-based
# adapter can find its fields after obfuscation.
-keep class com.cafe.pos.data.model.** { *; }
-keep class com.cafe.pos.data.api.** { *; }

# Moshi-Kotlin reflection metadata
-keep class kotlin.Metadata { *; }
-keep class kotlin.reflect.** { *; }
-keepclassmembers class * {
    @com.squareup.moshi.* <methods>;
    @com.squareup.moshi.* <fields>;
}

# --- OkHttp -----------------------------------------------------------
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# --- Coroutines -------------------------------------------------------
-dontwarn kotlinx.coroutines.debug.**

# --- Hilt / Dagger ---------------------------------------------------
# Hilt generates code at compile time; the generated classes are referenced
# by name from the manifest. Keep them and the entry points.
-keep class dagger.hilt.** { *; }
-keep class * extends dagger.hilt.android.internal.lifecycle.HiltViewModelFactory$ViewModelFactoriesEntryPoint { *; }
-keep class com.cafe.pos.CafePosApplication_HiltComponents$* { *; }
-keep class com.cafe.pos.**Hilt_*,**_HiltComponents$*,**_GeneratedInjector { *; }
-keepclassmembers class * {
    @dagger.hilt.android.AndroidEntryPoint *;
    @dagger.hilt.android.HiltAndroidApp *;
}

# --- Room ------------------------------------------------------------
# Room generates an impl class per @Dao; the impl is referenced by name
# from the generated database class. The @TypeConverter signatures must
# stay; their bodies can be obfuscated.
-keep class * extends androidx.room.RoomDatabase { *; }
-keep @androidx.room.Entity class * { *; }
-keepclassmembers @androidx.room.Entity class * { *; }
-keep class androidx.room.RoomDatabase$Builder { *; }

# --- WorkManager / Hilt-Work ----------------------------------------
# Hilt-Work generates *HiltModule classes; the worker class itself is
# instantiated by reflection by the WorkManager default factory.
-keep class androidx.work.** { *; }
-keep class com.cafe.pos.data.sync.SyncWorker
-keep class com.cafe.pos.data.sync.SyncWorker_HiltModule { *; }
-keep class * extends androidx.work.ListenableWorker
-keepclassmembers class * extends androidx.work.ListenableWorker {
    public <init>(android.content.Context, androidx.work.WorkerParameters);
}

# --- CameraX / ML Kit -------------------------------------------------
# ML Kit barcode scanner uses reflection to find its native bindings.
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.internal.mlkit_vision_barcode.** { *; }
-dontwarn com.google.mlkit.**

# CameraX is mostly safe; suppress warnings for the experimental APIs.
-dontwarn androidx.camera.**

# --- usb-serial-for-android ------------------------------------------
# Some driver classes are loaded via reflection from the prober.
-keep class com.hoho.android.usbserial.driver.** { *; }

# --- Compose ----------------------------------------------------------
# The Compose runtime ships its own consumer rules; we just suppress
# warnings for the bits it doesn't fully describe.
-dontwarn androidx.compose.**

# --- Kotlin metadata for reflection-based libs -----------------------
-keep class kotlin.Metadata { *; }
-keepattributes RuntimeVisibleAnnotations,RuntimeInvisibleAnnotations
-keepattributes RuntimeVisibleParameterAnnotations,RuntimeInvisibleParameterAnnotations
-keepattributes RuntimeVisibleTypeAnnotations,RuntimeInvisibleTypeAnnotations