---
name: android-app-engineering
description: Builds and changes Android apps that survive real devices. Use when writing or modifying Android code (Kotlin, Jetpack Compose or Views, ViewModel, Room, WorkManager, Gradle), handling lifecycle, configuration changes, process death, permissions or background work, or preparing a release build.
---

# Android App Engineering

## Overview

Android code that works on the emulator often fails on real devices: the screen rotates, the process is killed in the background, the user denies a permission, the network drops mid-request, the OS defers background work. Good Android engineering means writing every feature as if all of these will happen, because on some device they will. This skill covers how to structure the code so they are handled by design, not patched one crash report at a time.

## When to Use

- Adding or changing a screen, a ViewModel, a repository, or local storage
- Anything that touches lifecycle, configuration changes, or saved state
- Runtime permissions, notifications, background or scheduled work
- Gradle, dependencies, build variants, signing, R8, or release preparation
- Investigating a crash, ANR, memory leak, or "works on my device" bug

**NOT for:** server-side APIs the app calls (backend), or purely visual design decisions with no Android-specific behavior.

## Step 1: Read the Project Before Writing

Android projects diverge sharply. Before writing code, establish:

- **UI toolkit:** Jetpack Compose, Views (XML), or a mix. Follow what the module already uses; do not introduce Compose into a View-based screen (or the reverse) unless the task asks for it.
- **Architecture:** where state lives (ViewModel + StateFlow / LiveData), whether there is a domain layer, how navigation works.
- **DI:** Hilt, Koin, manual, or none. Use the existing one; never add a second.
- **Async:** coroutines + Flow, RxJava, or callbacks. Match it.
- **Build setup:** version catalog (`libs.versions.toml`), convention plugins, `minSdk` / `targetSdk` / `compileSdk`, build types and flavors.
- **Verify versions against the official docs.** Android APIs, Jetpack libraries, AGP, and Play policies change every year. Check current docs (developer.android.com, the library's release notes) for anything version-specific instead of relying on memory.

## Step 2: Architecture — Unidirectional Data Flow

Default structure for new code, unless the project has a different established one:

```
UI (Composable / Fragment)  ──events──▶  ViewModel  ──calls──▶  Repository  ──▶  data sources
          ▲                                  │                                  (Room, network, DataStore)
          └──────────── UiState (StateFlow) ─┘
```

- **UI is a function of state.** The ViewModel exposes one immutable `UiState` (data class) via `StateFlow`; the UI renders it and sends events up. The UI holds no business logic.
- **One-off effects** (navigate, show a snackbar) are modeled as state the UI consumes and acknowledges, or a dedicated channel; never as a re-emitting `StateFlow` value that fires again after rotation.
- **Repositories own data.** They expose `Flow`s, decide cache vs network, and map DTOs to domain models. ViewModels never touch Retrofit, Room DAOs, or `Context` directly.
- **No Android framework types below the ViewModel** where avoidable, so logic is unit-testable on the JVM.
- **Never hold an `Activity`, `Fragment`, `View`, or composable-scoped object in a ViewModel or singleton.** It leaks the whole screen. Use `Application` context only when a context is truly required.

## Step 3: Lifecycle, Configuration Changes, and Process Death

Three different events, three different tools:

| Event | Survives in | What to use |
|---|---|---|
| Rotation / configuration change | ViewModel | Keep screen state in the ViewModel |
| Process death (app in background, OS reclaims memory) | `SavedStateHandle` / `rememberSaveable` | Save small UI state: IDs, query text, scroll position, selected tab |
| App restart / long-term | Room, DataStore, files | Persist real data |

- **Test process death explicitly:** put the app in the background, then use "Don't keep activities" or `adb shell am kill <package>`, and return. A screen that comes back empty or crashes has a bug.
- **Collect flows lifecycle-aware:** `collectAsStateWithLifecycle()` in Compose, `repeatOnLifecycle(STARTED)` in Views. Plain `collect` in `lifecycleScope.launch` keeps working in the background and wastes battery or crashes on detached views.
- **Coroutine scopes:** `viewModelScope` for screen work, `lifecycleScope` only for UI-bound work. Never `GlobalScope`. Work that must outlive the screen goes to WorkManager.

## Step 4: Threading and Performance

- **Nothing slow on the main thread:** no disk, database, network, or large JSON parsing. Room and Retrofit suspend functions are main-safe; your own heavy work runs on `Dispatchers.IO` / `Default` via `withContext`. Main-thread blocking produces ANRs.
- **Inject dispatchers** instead of hard-coding them, so tests can control timing.
- **Compose:** keep composables cheap and side-effect free; side effects go in `LaunchedEffect` / `DisposableEffect` with correct keys. Use stable or immutable state types, provide `key` in lazy lists, and hoist state. Avoid reading rapidly changing state high in the tree.
- **Lists:** `LazyColumn` with keys, or `RecyclerView` with `DiffUtil` / `ListAdapter`. Never rebuild a whole list for one item change.
- **Images:** use the project's image loader (Coil, Glide) with sizing; never decode full-size bitmaps for thumbnails.
- **Startup:** do not do work in `Application.onCreate()` that can be deferred.

## Step 5: Permissions, Background Work, and Platform Rules

- **Runtime permissions:** request at the moment of use, with context, using the Activity Result API. Handle all three outcomes: granted, denied, and permanently denied (direct the user to settings). The feature must degrade gracefully when denied, never crash.
- **Request the minimum.** Prefer the photo picker over storage permissions, approximate over precise location, no background location unless the core feature needs it. Every permission in the manifest is reviewed on Play.
- **Notifications** need a runtime permission on recent Android versions and a notification channel.
- **Background work:** WorkManager for deferrable, guaranteed work (sync, uploads) with constraints. Foreground services only for user-visible ongoing work, with the correct declared type. Do not rely on exact timing; the OS batches and defers.
- **Targeting a new SDK level changes behavior** (edge-to-edge display, predictive back, foreground service types, background start restrictions). When raising `targetSdk`, read that version's behavior-changes page and test each affected area.
- **Exported components:** every `activity`, `service`, `receiver` with an intent filter must declare `android:exported` deliberately. Validate all data arriving through intents and deep links; it is untrusted input.

## Step 6: Data and Networking

- **Room:** every schema change bumps the database version and ships a migration. Never use destructive fallback on a database that holds user data. Export the schema and test migrations (`MigrationTestHelper`).
- **DataStore** for small key-value settings; not `SharedPreferences` in new code.
- **Offline first where it matters:** read from the local database as the source of truth, refresh from network in the repository.
- **Network errors are normal flow,** not exceptions to swallow: model loading / success / error in `UiState` and give the user a retry.
- **Secrets:** no API keys, signing passwords, or keystores in the repository or in `BuildConfig` committed values. Anything shipped in the APK is extractable; real secrets belong on the server.
- **Logging:** never log tokens, personal data, or full request bodies; strip debug logging from release builds.

## Step 7: Build and Release

- **Dependencies** go through the version catalog. Add a library only after checking the project does not already have one for the job.
- **Release builds use R8.** Test the actual release variant before shipping; reflection-based code (serialization, DI) can break under shrinking. Add keep rules narrowly, not `-keep class **`.
- **Signing config** reads from environment or a local, git-ignored properties file. Never commit the keystore or its passwords.
- **Version code** increases monotonically for every release uploaded to Play.
- **Baseline Profiles** for startup and critical journeys when performance matters.

## Step 8: Testing

| Layer | Tooling | What it covers |
|---|---|---|
| ViewModel, repository, mappers | JUnit on JVM, coroutine test dispatcher, Turbine for Flows, fakes over mocks | Logic and state transitions — the bulk of tests |
| Room DAOs, migrations | Instrumented tests or Robolectric, in-memory DB, `MigrationTestHelper` | Queries and schema upgrades |
| UI | Compose UI test (`createComposeRule`) or Espresso, with semantics / test tags | Rendering per state, user interactions |
| End-to-end on device | Instrumented tests on emulator / device | Critical journeys only |

- Prefer fakes (an in-memory repository) to mocking frameworks for your own types.
- Test the ViewModel against each `UiState` the screen can show: loading, content, empty, error.
- Run `./gradlew test` for JVM tests and `./gradlew connectedAndroidTest` for instrumented ones; `./gradlew lint` catches many platform mistakes (missing permissions, API level use, exported components).

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "It works on the emulator" | Emulators rarely kill your process, deny permissions, or run on a slow network. Test those paths deliberately. |
| "Rotation is locked, so I don't need saved state" | Process death still happens, and so do other configuration changes (dark mode, language, window resize). |
| "I'll just pass the Context into the ViewModel" | That leaks the Activity on every rotation. Use Application context or keep the work in the UI layer. |
| "fallbackToDestructiveMigration is fine for now" | It deletes every user's data on the next schema change. Write the migration. |
| "I'll ask for all permissions on first launch" | Users deny context-free requests, and Play review flags over-requesting. Ask at the moment of use. |
| "The key is obfuscated by R8" | Obfuscation is not protection. Anything in the APK can be extracted. |
| "Debug build works, release will too" | R8, signing, and build-type differences break release builds. Test the release variant. |

## Red Flags

- `Activity`, `Context`, `View`, or `Fragment` referenced from a ViewModel, repository, or `object`
- `GlobalScope`, `runBlocking` on the main thread, or network / disk work without a background dispatcher
- Flows collected without lifecycle awareness
- A screen that loses its state or crashes after process death
- Room schema change without a version bump and migration
- New permission added without a denied-path in the UI
- Secrets, keystores, or passwords in the repository
- A second DI framework, image loader, or networking library added next to an existing one
- `targetSdk` raised without reading that version's behavior changes

## Verification

Before reporting the task done:

- [ ] Code follows the module's existing UI toolkit, architecture, DI, and async patterns
- [ ] State survives rotation; small UI state survives process death (tested with "Don't keep activities" or `am kill`)
- [ ] No main-thread disk or network work; no leaked framework references
- [ ] Every new permission has granted, denied, and permanently-denied handling
- [ ] Room changes ship a tested migration
- [ ] `./gradlew test` and `./gradlew lint` pass; instrumented tests run where the change touches DB or UI
- [ ] Release variant builds and the changed feature works in it (when the change affects shrinking, reflection, or build config)
- [ ] Version-specific API or policy details were checked against current official docs
