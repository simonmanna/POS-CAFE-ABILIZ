# POS-Android

Native Android (Kotlin + Jetpack Compose) tablet POS that talks to the existing
**NestJS** POS backend at `C:\Users\USER\Documents\Simon-GitHub\POS-Cafe`.

The web POS at `apps/web/` is **unchanged**. This project lives alongside it and
shares the same business rules via the REST API.

| | |
|---|---|
| **Build status** | green — `assembleDebug` ✓, `testDebugUnitTest` ✓, `bundleRelease` ✓ |
| **APK (debug)** | 43.8 MB |
| **AAB (release)** | 17.7 MB (R8 minified) |
| **Tests** | 23/23 passing per build |
| **Kotlin sources** | 80 files |

## Phase summary

| Phase | Scope | Status |
|---|---|---|
| 0 | Project scaffold (Gradle, AGP 8.5.2, Kotlin 1.9.24, JDK 17, manifest, themes) | ✅ |
| 1 | First clean build — KDoc fixes, Hilt Provider wiring, scope fixes | ✅ |
| 2 | Hardware drivers: USB ESC/POS, Bluetooth ESC/POS, CameraX+ML Kit scanner, NFC | ✅ |
| 2x | Network ESC/POS printer, real `EscPosCashDrawer`, `PrinterPreferences` (auto-reconnect), scanner torch + haptic, `ReceiptPipelineTest` | ✅ |
| 3 | Web feature parity: manager override, line/tx discounts, modifier sheet, customer attach, hold cart, settings | ✅ |
| 4a | `ShiftOpenDialog` + `ShiftCloseDialog` (cash session lifecycle), auto-print receipt on successful checkout, **block checkout if no shift** | ✅ |
| 4b | Offline hardening: `SyncWorker` + `NetworkConnectivityMonitor` + exponential backoff + `SyncStatusBanner` + non-destructive Room v2 migration | ✅ |
| 4c | **Biometric unlock + 5-min auto-lock** (`BiometricPrompt`, `SessionLockController`, `SessionLockOverlay`) | ✅ |
| 5 | Production polish: release signing, AAB build, R8/ProGuard rules, deprecated-icon migration, dark-theme refinement, `CrashReporter` hook, GitHub Actions CI | ✅ |
| 6 | Web feature gap close: combo picker UI, refund/void with manager override, loyalty redeem + earn notification | ✅ |
| 7 | **AGP 8.5 → 8.7** + **Kotlin 1.9 → 2.0** + **R8 re-enabled** → AAB 24 MB → 17.7 MB | ✅ |
| 8 | Polish: Z-report auto-print on close shift, KDS auto-claim, cart persistence across process death, adaptive launcher icon, SentryCrashReporter skeleton | ✅ |

## What this app does

**Sales flow** (login → terminal → checkout → receipt):
- Login with organization code + email + password; TOTP MFA when enrolled.
- Tablet-optimized terminal: menu grid (categories, search, scanner) on the left, cart on the right (side-by-side on ≥ 840dp, stacked on phones).
- Hold / recall / cancel held orders.
- Checkout with split tender, change calc, manager-override on discounts >10%.
- Modifier sheets (multi-select with price deltas).
- Customer attach (search by email/phone/ID, fetch loyalty points).
- Auto-print receipt to the active ESC/POS printer (USB / Bluetooth / TCP).
- Z-Report + X-Report + hourly buckets + top items.
- Manager override (PIN + password).

**Cash session lifecycle**:
- **Open shift** with quick-pick register chips + opening float chips.
- **Close shift** with live variance calc (expected vs. counted).
- "No shift open" red banner in the terminal until one is opened.
- Checkout blocked while no shift is open.

**Hardware** (Android-only; web has none):
- USB ESC/POS printers via `usb-serial-for-android`.
- Bluetooth classic SPP ESC/POS printers.
- Network (TCP 9100) ESC/POS printers (Epson TM-T88, Star TSP143).
- CameraX + ML Kit barcode scanner with torch + haptic.
- NFC reader (NDEF text/URI + raw tag ID).
- Cash drawer via ESC/POS pulse through active printer.

**Offline-first**:
- Room-cached product catalog.
- Pending sales queue with client-generated `Idempotency-Key`.
- `SyncWorker` (WorkManager, periodic 15min + on-connectivity + manual).
- Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s; dead-letter at 8 attempts.
- `SyncStatusBanner` in the terminal with pending count + "Sync now" button.

## Architecture

```
POS-Android/
├── app/
│   ├── build.gradle.kts                 # AGP 8.5.2, Kotlin 1.9.24, JDK 17
│   ├── proguard-rules.pro               # R8 rules (Retrofit, Moshi, Hilt, Room, ML Kit, WorkManager)
│   └── src/
│       ├── main/java/com/cafe/pos/
│       │   ├── CafePosApplication.kt    # WorkManager init, connectivity callback, crash handler
│       │   ├── MainActivity.kt          # single-activity host
│       │   ├── data/
│       │   │   ├── api/                 # AuthApi, CatalogApi, PosApi, CashSessionApi
│       │   │   ├── model/               # DTOs mirror NestJS contracts
│       │   │   ├── local/               # Room (catalog cache + pending sales)
│       │   │   ├── auth/                # TokenStore (DataStore)
│       │   │   ├── connectivity/        # NetworkConnectivityMonitor
│       │   │   ├── sync/                # SyncWorker, SyncScheduler, SyncBackoff, SyncStatusViewModel
│       │   │   ├── session/             # ShiftSessionBootstrap
│       │   │   └── repository/          # Auth, Catalog, Pos, CashSession
│       │   ├── domain/
│       │   │   ├── cart/                # CartStore (1:1 port of web's zustand cart.store.ts)
│       │   │   └── session/             # ShiftSessionStore (singleton in-memory state)
│       │   ├── di/                      # Network, Database, Hardware, Telemetry modules
│       │   ├── hardware/                # PrinterManager, BarcodeScanner, NFC, CashDrawer
│       │   │                            # + impl/ for real drivers (USB, BT, Network, CameraX, NFC)
│       │   ├── telemetry/               # CrashReporter (replace ConsoleCrashReporter for prod)
│       │   └── ui/
│       │       ├── theme/               # Material 3 cafe palette
│       │       ├── components/          # OfflineBanner, SyncStatusBanner, ScannerSheet
│       │       ├── navigation/          # Routes, CafePosNavHost, RootViewModel
│       │       └── screens/
│       │           ├── login/           # Login + MFA
│       │           ├── terminal/        # Main POS terminal
│       │           ├── checkout/        # Payment, split tender, auto-print
│       │           ├── holds/           # Hold list, recall, cancel, hold dialog
│       │           ├── kds/             # Kitchen Display (5s polling)
│       │           ├── reports/          # X/Z/hourly/top
│       │           ├── receipts/         # Receipt view + re-print
│       │           ├── settings/         # Printer/scanner picker
│       │           ├── cashsession/      # Shift open + close
│       │           ├── manager/          # Manager override (PIN + password)
│       │           ├── discount/         # Line + transaction discount
│       │           ├── modifiers/        # Modifier sheet
│       │           └── customers/        # Customer attach
│       └── test/java/com/cafe/pos/       # CartStore, EscPosBuilder, ReceiptPipeline, SyncBackoff
├── gradle/
│   ├── libs.versions.toml               # version catalog
│   └── wrapper/                         # gradle-wrapper.jar (8.7)
├── .github/workflows/android.yml        # CI: lint + test + assembleDebug + bundleRelease
├── keystore.properties.template         # how to wire your release keystore
├── gradlew, gradlew.bat
├── build.gradle.kts, settings.gradle.kts
├── gradle.properties
├── local.properties                     # gitignored; has sdk.dir + API_BASE_URL
└── README.md                            # you are here
```

## Setup

### 1. Open in Android Studio

Open Android Studio → **Open** → pick `POS-Android/`.

### 2. Configure API base URL

`local.properties` (gitignored) is created automatically. Override with:
```
API_BASE_URL=http://10.0.2.2:3000/      # Android emulator → host loopback
# API_BASE_URL=http://192.168.1.42:3000/  # real tablet on LAN
# API_BASE_URL=https://api.yourdomain.com/ # production
```

Or at build time:
```bash
./gradlew assembleDebug -PAPI_BASE_URL=http://192.168.1.42:3000/
```

### 3. Start the web POS backend

```bash
cd C:\Users\USER\Documents\Simon-GitHub\POS-Cafe
pnpm --filter @erp/api dev
```

### 4. Build & run

```bash
cd C:\Users\USER\Documents\Simon-GitHub\POS-Android
./gradlew assembleDebug          # APK
./gradlew bundleRelease          # AAB (Play Store distribution)
./gradlew test                   # 46 unit tests
```

### 5. Sign in

Use the same credentials as the web POS. If MFA is enrolled, you'll be prompted for the 6-digit code.

### 6. Open a shift

The terminal will show a red "No shift open" banner until you tap **Open shift** in the top app bar, pick a register, and enter the opening float.

## Known issues

### R8 minification is enabled, but the `keep` rules may need tuning in production

R8 8.7.x (the version that ships with AGP 8.7.3) shrinks the release AAB from 24 MB to **17.7 MB**. The `proguard-rules.pro` covers Retrofit, Moshi-Kotlin, Hilt, Room, WorkManager, ML Kit, usb-serial, and Compose. When you actually run the R8'd APK on a real device, exercise every flow (login, shift, checkout, refund, KDS, scanner, printer) — if a class gets stripped that Hilt/Retrofit needs at runtime, add it to the rules. Common additions: `@Keep`-annotated Hilt entry points and any Room `@TypeConverter` you add.

### Crash reporter

`ConsoleCrashReporter` logs to logcat. To ship to a real cafe, bind a real implementation in `TelemetryModule.kt`:

```kotlin
@Binds @Singleton
abstract fun bindCrashReporter(impl: SentryCrashReporter): CrashReporter
```

Sentry's `SentryCrashReporter` would call `Sentry.captureException(t)` in `report()` and `Sentry.setUser(...)` in `setUser()`. Crashlytics and Bugsnag follow the same shape.

## CI

`.github/workflows/android.yml` runs on every push to `main`/`develop` and every PR:
1. Lint (`./gradlew :app:lintDebug`)
2. Unit tests (`./gradlew :app:testDebugUnitTest`)
3. `assembleDebug` → uploads `app-debug.apk`
4. `bundleRelease` (only if `POS_KEYSTORE_BASE64` secret is present) → uploads `app-release.aab`

Required CI secrets for the release AAB:
- `POS_KEYSTORE_BASE64` — base64 of the keystore file
- `POS_KEYSTORE_PASSWORD` — keystore password
- `POS_KEY_ALIAS` — key alias
- `POS_KEY_PASSWORD` — key password

## API contract

The app calls the existing NestJS API. No business logic is duplicated; the Android side mirrors validation for UX (e.g., disabling Pay when cart is empty) but the source of truth is the server.

See the original `POS-Cafe/README.md` for the full backend API surface. Highlights used by Android:

| Method | Path | Caller |
|---|---|---|
| POST | `/auth/login` | `AuthRepository.login()` |
| POST | `/auth/refresh` | `TokenAuthenticator` (on 401) |
| GET | `/products` | `CatalogRepository.refresh()` |
| GET | `/pos/lookup?sku=` | `CatalogRepository.lookupSku()` |
| POST | `/pos/checkout` | `PosRepository.checkout()` (Idempotency-Key) |
| POST | `/pos/holds` | `PosRepository.createHold()` |
| POST | `/pos/holds/:id/recall` | `PosRepository.recallHold()` |
| POST | `/pos/override/verify` | `PosRepository.verifyOverride()` |
| GET | `/pos/reports/x-report` | `PosRepository.xReport()` |
| GET | `/pos/reports/z-report` | `PosRepository.zReport()` |
| GET | `/pos/kds/tickets` | `PosRepository.kdsTickets()` (5s polling) |
| GET | `/cash-registers` | `CashSessionRepository.listRegisters()` |
| GET | `/cash-sessions/open` | `CashSessionRepository.activeSession()` |
| POST | `/cash-sessions/open` | `CashSessionRepository.openSession()` |
| POST | `/cash-sessions/close` | `CashSessionRepository.closeSession()` |
| GET | `/cash-sessions/:id/expected` | `CashSessionRepository.expectedCash()` |
