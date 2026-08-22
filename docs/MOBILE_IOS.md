# MOBILE_IOS.md

The Nuxt web frontend (`apps/web`) is packaged as an iOS app via [Capacitor](https://capacitorjs.com/). The iOS app is a thin client only — all trading logic, secrets, and the DEMO-only safety gates (`DemoExecutionGateway`, Risk Engine, kill switch) stay server-side in `apps/api` and `services/trading-engine`, unchanged.

**The owner does not need to personally own a Mac.** Everything except the final native compile/sign step runs on Windows. A macOS environment is still required somewhere for that final step — this doc uses a free GitHub Actions macOS runner for it, so no Mac purchase or rental is needed to keep making progress.

## Three workflows

| | Windows dev | iPhone testing today | Native app later |
|---|---|---|---|
| **Workflow** | A | B | C |
| What it needs | Just this PC | This PC + an iPhone on the same Wi-Fi | This PC + GitHub (cloud macOS runner) |
| What you get | Working code, browser testing | A real, installed-feeling app icon on the iPhone home screen | A signed IPA / TestFlight build |
| Requires a Mac? | No | No | No — cloud macOS CI does the compiling |

### Workflow A — Windows development

```
Windows → Nuxt / API / Trading Engine / MT5 → browser responsive testing
```

Everything from day-to-day feature work happens here. See "What works on Windows" below for the exact commands.

### Workflow B — iPhone today, without a Mac

```
Windows server (LAN) → iPhone Safari → Add to Home Screen → installed-feeling web app
```

Gets a real, testable, home-screen icon on the owner's iPhone **today**, with zero native build step. See "Workflow B in detail" below.

### Workflow C — native iOS later, via cloud macOS

```
Windows development → GitHub → cloud macOS runner (GitHub Actions) → Xcode build/sign → IPA / TestFlight
```

For the eventual native App Store build. The owner writes and pushes code from Windows; a macOS runner in the cloud does the part that literally requires Apple's toolchain. See "Workflow C in detail" below.

---

## What runs where

| Piece | Where it lives | Changed for iOS? |
|---|---|---|
| Nuxt UI | `apps/web` | Yes — new static build mode, PWA fallback, Capacitor wrapper |
| Node API | `apps/api` | Small config additions only (CORS allow-list, CORP header) |
| Python trading engine | `services/trading-engine` | No |
| Postgres | Docker | No |
| `ios/` Xcode project | `apps/web/ios` | New (Capacitor-generated) |
| `.github/workflows/ios-build.yml` | repo root | New (cloud macOS build) |

## What works on Windows (Workflow A)

All of this runs directly on this Windows machine, no Mac involved:

```bash
# from repo root
npm run dev:web            # Nuxt dev server
npm run dev:web:lan        # same, but LAN-reachable (0.0.0.0) for Workflow B
npm run dev:api            # Node API
npm run test               # web + API test suites
npm run typecheck          # web + API
npm run lint               # web + API
npm run build              # normal SSR web build (unchanged)
npm run build:mobile       # static Capacitor bundle + secret audit
npm run mobile:audit       # re-run just the secret audit against an existing build
npm run ios:sync           # npx cap sync ios (from apps/web) - regenerates ios/App/App/public and Package.swift
npm run ios:ci-check       # build:mobile + ios:sync in one step - everything possible before Xcode
```

`npx cap add ios` (re-generating the `ios/` project from scratch, if it's ever deleted) also works on Windows — confirmed on this machine. That's because this project's Capacitor plugins (`@capacitor/app`, `@capacitor/network`, `@aparajita/capacitor-secure-storage`) all resolve via Swift Package Manager, not CocoaPods, so there's no Ruby/CocoaPods step to fail on Windows.

**What does not work on Windows**, and never will (Apple restriction, not a tooling gap):
- Opening the project in Xcode (`npx cap open ios`).
- Compiling, running on the iOS Simulator, running on a physical iPhone.
- Code signing, provisioning profiles.
- Archiving a build / producing a signed IPA.

Workflow C below moves exactly that (and only that) part to a cloud macOS runner.

---

## Workflow B in detail — iPhone testing without a Mac

This is the fastest path to something the owner can actually tap on their iPhone today.

1. Find this machine's LAN IP: `ipconfig`, look for the Wi-Fi/Ethernet adapter's IPv4 address (e.g. `192.168.1.50`). Never hardcode this into a committed file — it's a per-network value, passed as an env var each time.
2. Start the API LAN-reachable — it already binds `0.0.0.0:4000` by default (`apps/api/src/index.ts`), no change needed.
3. Start the web dev server LAN-reachable: `npm run dev:web:lan` (binds `0.0.0.0:3000`, unlike the default `nuxt dev`, which only listens on `localhost`).
4. Allow inbound connections on ports 3000 and 4000 for the "Private" network profile in Windows Firewall.
5. Set `NUXT_PUBLIC_API_URL=http://<LAN_IP>:4000` before starting the web dev server, so the frontend talks to the API by LAN IP instead of `localhost`.
6. On the iPhone (same Wi-Fi): open Safari, go to `http://<LAN_IP>:3000`, log in, then tap Share → **Add to Home Screen**.
7. Launch the app from the home screen icon. It opens full-screen, no Safari address bar (`display: standalone` in `apps/web/public/manifest.webmanifest`, plus `apple-mobile-web-app-capable` in `apps/web/nuxt.config.ts`) — this is Safari's classic home-screen-webapp behavior, which has never required a service worker or HTTPS, so it works over plain LAN HTTP.
8. This app **does not** register a service worker on purpose — every request always hits the live API, so it's never possible to see stale trade/price/position data because of a cache. "Add to Home Screen" only gets you the icon + standalone window, not offline caching, and that's intentional here.

This is development-only. Plain HTTP is fine for this LAN testing flow; it is never acceptable for anything the app is built to point at permanently (see "Production API" below).

---

## Workflow C in detail — native build via cloud macOS

`.github/workflows/ios-build.yml` runs on GitHub's `macos-latest` runners (free for public repos; metered minutes for private repos — check GitHub's current pricing for your repo's visibility).

**Two jobs:**

1. **`validate`** (always runs, on every push/PR touching `apps/web/**`): installs dependencies, runs `npm run ios:ci-check` (mobile build + secret audit + `cap sync`), then compiles the generated Xcode project for the iOS Simulator with `CODE_SIGNING_ALLOWED=NO`. This needs **no Apple account, no certificates, nothing** — it only proves the generated native project actually compiles. This is the job that should stay green on every PR.
2. **`signed-distribution`** (manual only — `workflow_dispatch` with the "run signed build" checkbox): archives and exports a real signed `.ipa`, uploaded as a downloadable GitHub Actions artifact. Automatically skipped (not failed) if the required secrets aren't configured yet, so the normal CI run is never blocked by missing Apple credentials.

### Required GitHub secrets (for the signed job only — names only, add the actual values in the repo's Settings → Secrets)

| Secret | What it is |
|---|---|
| `IOS_DIST_CERTIFICATE_P12` | base64-encoded Apple distribution certificate (`.p12`) |
| `IOS_DIST_CERTIFICATE_PASSWORD` | password for that `.p12` |
| `IOS_PROVISIONING_PROFILE` | base64-encoded provisioning profile (`.mobileprovision`) |
| `IOS_TEAM_ID` | Apple Developer Team ID |

Optional, only needed for a future *automated* TestFlight upload (not implemented — uploads stay manual):

| Secret | What it is |
|---|---|
| `APP_STORE_CONNECT_API_KEY_ID` | App Store Connect API key ID |
| `APP_STORE_CONNECT_API_ISSUER_ID` | App Store Connect API issuer ID |
| `APP_STORE_CONNECT_API_KEY_P8` | base64-encoded App Store Connect API key (`.p8`) |

Optional repository **variable** (Settings → Variables, not Secrets — it's not sensitive): `MOBILE_API_URL`, the real HTTPS API URL to bake into a signed build. Defaults to a placeholder if unset, which is fine for the unsigned `validate` job.

**Never commit** any certificate, `.p12`/`.mobileprovision` file, or API key to the repository — CI secret storage only.

### CI provider neutrality

Every actual build step in the workflow is a plain npm script (`npm ci`, `npm run ios:ci-check`) or a standard `xcodebuild` invocation — nothing in `apps/web` or `apps/api` is aware of GitHub Actions specifically. The same steps work on Codemagic, Bitrise, or any other macOS CI service by copying the equivalent commands into that provider's config; `.github/workflows/ios-build.yml` is just one thin orchestration layer, not a hard dependency.

---

## Production API

A Capacitor build now **refuses to compile** if it's pointed at plain HTTP without an explicit opt-in (`apps/web/nuxt.config.ts`, mirrored at runtime in `apps/web/composables/useApi.ts`'s `validateMobileApiUrl`):

- `NUXT_PUBLIC_API_URL` must start with `https://`, **or**
- `NUXT_PUBLIC_ALLOW_INSECURE_MOBILE_API=true` must be set explicitly (Workflow B's LAN testing only — never set this for anything shipped).

```
iOS App → HTTPS API (your domain) → Trading engine → MT5 DEMO
```

No LAN IP is required or hardcoded for a production build — set `NUXT_PUBLIC_API_URL` to your HTTPS API domain at build time (e.g. via the `MOBILE_API_URL` repository variable for the signed CI job), and add that domain to `CORS_ORIGIN` on the API.

CORS already accepts the LAN web origin and the Capacitor iOS origins (`capacitor://localhost`, `http://localhost`, `ionic://localhost`) by default — see `apps/api/src/app.ts`. Add your production web/API origins to `CORS_ORIGIN` (comma-separated) when you have them.

iOS App Transport Security blocks plain HTTP by default; a production HTTPS API needs no ATS exception at all. An ATS local-network exception is only relevant for on-device (not simulator) LAN testing in a future native build, and must never be added for a production build talking to a public domain.

## Authentication on iOS

The web app uses a `SameSite=Strict` session cookie, which cannot survive the cross-origin hop from a Capacitor WebView to the API host. Capacitor builds instead use the JWT the API already returns in the `/auth/login` response body (`sessionToken`), sent as `Authorization: Bearer <token>` on every request — the API already accepts this (`apps/api/src/auth/middleware.ts`) with CSRF skipped whenever there's no session cookie.

The token is stored via **`@aparajita/capacitor-secure-storage`**, backed by the iOS Keychain (Android Keystore-backed on Android) — not `@capacitor/preferences`, which is plain unencrypted `UserDefaults`. See `apps/web/composables/useTokenStorage.ts`:
- Secure storage on iOS: yes, Keychain-backed.
- Restored after app restart: yes — `getToken()` reads it back on the next launch.
- Deleted on logout: yes — `useAuth.ts`'s `logout()` calls `clearToken()`.
- Never logged: no code path in `useTokenStorage.ts` logs the token value (enforced by a static-scan test, `apps/web/tests/mobile-capacitor.test.ts`).
- Never in the static bundle: it's a runtime-only value written to the Keychain after login, never baked into the build (enforced by the secret-audit script).

Plain web keeps the existing cookie + CSRF flow untouched — this plugin is never touched outside a native build (`isNative()` gate in `useTokenStorage.ts`).

## App Store / TestFlight preparation checklist

Nothing here has been submitted or signed — this is a checklist for when that's ready.

- [ ] Apple Developer Program account (individual or org)
- [ ] App Store Connect app record created, bundle ID `com.aidemolab.mt5demo`
- [ ] Real app icon set (1024×1024 + all required sizes) — the current icons (`apps/web/public/icons/`) are placeholders, generated programmatically, not real branding
- [ ] Launch screen — Capacitor's default is a placeholder; needs real branding
- [ ] Privacy Nutrition Label / `PrivacyInfo.xcprivacy` — declare what data the app collects (trade data, login email) and why
- [ ] `Info.plist` network security config reviewed (only your HTTPS API domain is contacted; no ATS exceptions in the production build)
- [ ] Signing certificate + provisioning profile added as GitHub secrets (see Workflow C above)
- [ ] App Store description/screenshots clearly state: **DEMO trading software, MT5 DEMO accounts only, no real money at risk**
- [ ] TestFlight internal build tested end-to-end (login, AI Trade, Fast Learning, Open Trades, History, Settings) before any external testers are invited
- [ ] Do not submit for App Store review until the owner explicitly decides to
