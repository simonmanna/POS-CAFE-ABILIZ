# POS Cafe — Android (offline-first)

Native Kotlin POS terminal that works **fully offline** and syncs with the
POS-CAFE server (`apps/api`) when it reconnects. It runs standalone: its own
encrypted database, its own receipt printing, its own cash sessions.

Protocol: [`docs/sync-protocol.md`](../../docs/sync-protocol.md).
Setup on a real phone: [`docs/lan-deployment.md`](../../docs/lan-deployment.md).

## Build (no Android Studio needed)

Requires a JDK 17+ and the Android SDK. If Android Studio is installed you
already have both — you just never have to open it.

```bash
cd apps/android
export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"   # or any JDK 17+
./gradlew :app:assembleDebug          # → app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:testDebugUnitTest      # pricing parity + cart maths
```

`local.properties` must point at your SDK (git-ignored):

```properties
sdk.dir=C:/Users/Simon/AppData/Local/Android/Sdk
```

Install it:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Toolchain: Gradle 8.13 · AGP 8.7.3 · Kotlin 2.0.21 · compileSdk 35 · minSdk 26.

## Stack

| Concern | Choice |
|---|---|
| UI | Jetpack Compose (Material 3) |
| DI | Hilt |
| Local DB | Room over **SQLCipher** (key in Android Keystore) |
| Network | Retrofit + OkHttp + kotlinx.serialization |
| Background sync | WorkManager (periodic 15 min + on demand) |
| Offline login | bcrypt verified on-device against the synced `pinHash` |
| Printing | ESC/POS 48-col over TCP 9100 |

## How it works

1. **Enroll once.** A manager registers the device in the web back office
   (Settings → Offline devices) and gets a token shown *once*. Enter the server
   URL, device id, token and prefix on the tablet's setup screen; the first
   pull seeds the catalog.
2. **Sell offline.** Menu, cart and checkout run entirely from Room. Each sale
   gets a provisional number (`D1-000042`, printed with an OFFLINE marker) and
   is appended to the op queue.
3. **Sync.** `SyncWorker` pushes the queue (`POST /sync/push` — per-op
   idempotency, so a re-push never double-charges), then pulls catalog deltas.
   The response maps provisional → final invoice numbers.
4. **Failures stay visible.** Ops the server rejects are dead-lettered
   server-side and flagged locally on the Sync screen. Money is never silently
   dropped.

## Pricing parity — important

The device prices a cart offline and prints a receipt; the server re-prices the
same cart on sync. **They must agree.** `CartVectorParityTest` asserts this
against golden vectors generated from the real server pricing services:

```bash
# regenerate after ANY server pricing change, then re-run the Android tests
pnpm --filter @erp/api exec ts-node scripts/export-cart-vectors.ts
cd apps/android && ./gradlew :app:testDebugUnitTest
```

Note `MenuItem.basePrice` arrives in MINOR units (×100) and is converted once at
pull-apply (`CartEngine.basePriceToMajor`); variants, modifier deltas and
accompaniment upcharges are already MAJOR.

## Networking

`network_security_config.xml` permits cleartext HTTP **only** to private ranges
(`10/8`, `172.16/12`, `192.168/16`, loopback) — the cafe LAN. Anything on the
public internet must be HTTPS. The server URL is device config and can be
changed at any time without reinstalling (`DynamicHostInterceptor`).

## Cash & inventory sync

The till pulls the org's tender tiles, ledger accounts (pre-classified by
role), expense categories, stock locations and stock levels, and pushes ops
the server's shift and stock rules accept (see the protocol doc):

- **Shift**: open checks the float against the drawer ledger (extra float needs
  a funding account + reason); cash in/out picks its counterpart account;
  cash-outs need a manager PIN; close counts every shift-tracked wallet, asks
  for a reason on any difference and a manager PIN when the server will.
- **Terminal**: payment tiles come from the server; each tender carries its
  receiving account; cash change is sent as `amountTendered`.
- **Stock** (retail products): purchases, waste and adjustments sync as
  `stock.in` / `stock.out` with an approver; physical counts sync as a server
  spot count. On-hand shows the server figure plus unsynced local movements.
- **Expenses**: from the drawer (a cash-out), from a safe/bank/wallet, or on
  credit (`expense.create`).

Managers holding the permission approve their own stock movements without a
PIN; everyone else needs a manager PIN, verified on-device and again on replay.
Menu-item stock stays device-local (the server tracks ingredients via recipes).

## Not built yet

- Bluetooth SPP printing (TCP 9100 works; the transport seam is in place)
- Branch stock transfers from the device (back office only)
