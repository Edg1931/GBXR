// Android XR app. Not built in CI without an Android SDK (see settings.gradle.kts).
// Jetpack XR libraries are pre-release: bump the versions below to the latest
// from https://developer.android.com/jetpack/androidx/releases/xr-scenecore and
// fix any renamed APIs in xr/XrStage.kt (the only file that touches them).
plugins {
    id("com.android.application") version "8.13.0"
    kotlin("android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.gbxr.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.gbxr.app"
        minSdk = 34
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("String", "BACKEND_URL", "\"${project.findProperty("gbxr.backendUrl") ?: "http://10.0.2.2:8787"}\"")
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation(project(":core"))

    implementation(platform("androidx.compose:compose-bom:2025.10.00"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.4")

    implementation("androidx.camera:camera-camera2:1.5.1")
    implementation("androidx.camera:camera-lifecycle:1.5.1")

    // Jetpack XR (pre-release; update versions).
    implementation("androidx.xr.runtime:runtime:1.0.0-alpha06")
    implementation("androidx.xr.scenecore:scenecore:1.0.0-alpha07")
    implementation("androidx.xr.arcore:arcore:1.0.0-alpha06")
    implementation("androidx.xr.compose:compose:1.0.0-alpha07")
}

// Ship the shared bot profiles (repo-level bots folder) inside the APK as assets/bots.
val syncBots by tasks.registering(Sync::class) {
    from(rootProject.file("bots"))
    into(layout.buildDirectory.dir("generated/botAssets/bots"))
}
android.sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/botAssets"))
tasks.named("preBuild") { dependsOn(syncBots) }
