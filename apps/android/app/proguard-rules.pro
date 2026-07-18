# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keep,includedescriptorclasses class com.poscafe.pos.**$$serializer { *; }
-keepclassmembers class com.poscafe.pos.** { *** Companion; }
-keepclasseswithmembers class com.poscafe.pos.** { kotlinx.serialization.KSerializer serializer(...); }

# SQLCipher
-keep class net.zetetic.database.** { *; }
