# Install whoof as a real native iOS app — free, no Apple Developer account

Unlike the PWA path (see `IPHONE.md`), this gets you:

- **Direct Bluetooth pairing from the iPhone** to your Whoop 4.0 strap — no need to pair on Mac and shuttle JSON
- A real app icon, app switcher card, fullscreen launch
- Proper background life-cycle
- Installs via Xcode signing your **free Apple ID**

The one trade-off: signed apps from a free Apple ID **expire every 7 days**.
Re-build & re-install in Xcode each week to refresh — takes about 30 seconds.

---

## One-time setup (5 minutes)

You already have what you need (per your earlier answers):
- ✅ Xcode installed
- ✅ Free Apple ID signed into Xcode
- ✅ Node.js (v25.x is fine)

### 1. Build the native iOS project

From the repo root:

```bash
npm install                # if you haven't already
npx cap sync ios           # copies the latest /web into the iOS bundle
npx cap open ios           # opens the project in Xcode
```

`npx cap open ios` launches Xcode with the project at `ios/App/App.xcworkspace`.

### 2. Configure signing in Xcode (one-time)

Inside Xcode:

1. **Click the blue "App" project icon** in the left sidebar (top of the tree)
2. Make sure the **"App" target** is selected (centre pane, top-left dropdown)
3. Go to the **"Signing & Capabilities"** tab
4. **Team** → pick your Apple ID (it shows up as *"Your Name (Personal Team)"*)
5. **Bundle Identifier** → change `com.whoof.dashboard` to something
   unique under your Apple ID — Xcode requires this for personal-team signing.
   Suggestion: `com.<yourname>.whoof` (e.g. `com.madhur.whoof`)
6. Xcode will say *"Automatically manage signing"* — leave it checked

### 3. Plug in the iPhone & enable Developer Mode

1. Plug your iPhone into the Mac with a Lightning/USB-C cable
2. Tap **Trust This Computer** on the phone if prompted
3. On the iPhone: **Settings → Privacy & Security → Developer Mode → On**
   (requires a restart). This is iOS's safety gate for sideloaded apps.

### 4. Run it

In Xcode, top centre, click the device dropdown next to the "App" scheme and pick
your iPhone (e.g. *"Madhur's iPhone"*). Then hit the big **▶ Play** button.

Xcode builds, signs, and installs the app. First time may take 2–3 minutes.

The first launch on the iPhone:

1. iOS will say **"Untrusted Developer"** → tap OK
2. On the phone, go to **Settings → General → VPN & Device Management →
   <Your Apple ID> → Trust**
3. Re-launch whoof from the Home Screen

You should see the dashboard with the same three-ring layout, but now it can
talk to your Whoop strap natively via Bluetooth.

---

## Weekly refresh (the 7-day caveat)

Free Apple-ID-signed apps stop launching after 7 days. To refresh:

```bash
npx cap open ios
```

Plug in the phone, hit ▶ in Xcode. Done — 30-second operation.

If you want this to be even quicker, the **AltStore** project automates the
re-sign over Wi-Fi from your Mac. We can wire that in later if the weekly
re-build becomes annoying.

---

## Workflow during development

After any code change in `/web`:

```bash
npx cap sync ios
```

(or just `npx cap copy ios` if you only changed web assets and not plugins.)

Then re-run from Xcode (▶). The web view inside the app picks up your changes.

---

## What's different from the PWA

| | PWA (Add to Home Screen) | Native (this guide) |
|---|---|---|
| Web Bluetooth | ❌ Apple disabled it | ✅ Bridged to Core Bluetooth via Capacitor plugin |
| Install path | Safari → Share | Xcode → ▶ |
| Apple Developer account | Not needed | Not needed |
| Renewal | None | Every 7 days, free |
| Auto-updates | ✅ Just refresh page | Re-run Xcode build |
| App icon / fullscreen / task card | ✅ | ✅ |

---

## Troubleshooting

**"Could not launch app — Untrusted Developer"**
→ Settings → General → VPN & Device Management → Trust your Apple ID

**"This app cannot be installed because its integrity could not be verified"**
→ Your 7-day signature has expired. Re-run Xcode ▶ to re-install.

**Bluetooth doesn't find the strap**
→ Make sure the strap is awake (tap or charge it briefly). The first
connection requires the iOS Bluetooth permission prompt — accept it.

**Bundle identifier conflict**
→ Another app on your Apple ID is using the same bundle ID. Change it under
Signing & Capabilities to something unique like `com.yourname.whoof`.

**App quits immediately on launch**
→ Check Xcode's console (Window → Devices and Simulators → select your phone → View Device Logs)
for the crash log. Common cause: the BLE plugin's permissions weren't
granted — uninstall & re-install.

**Charts look blurry or laggy**
→ The WebKit view inside the app uses your iPhone's GPU. On older phones
(pre-iPhone 12) the 30-day stacked bar chart may stutter — switch to the
7-day window via the tab control.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│  iOS app (signed with free Apple ID)            │
│  ┌───────────────────────────────────────────┐  │
│  │  WKWebView                                │  │
│  │  ┌─────────────────────────────────────┐  │  │
│  │  │  whoof dashboard (web/)         │  │  │
│  │  │  - Same HTML / CSS / JS as on web   │  │  │
│  │  │  - Uses navigator.bluetooth         │  │  │
│  │  └────────────┬────────────────────────┘  │  │
│  │               │ (bridged by                │  │
│  │               │  ble/capacitor-bridge.js)  │  │
│  │  ┌────────────▼────────────────────────┐  │  │
│  │  │  Capacitor BluetoothLe plugin       │  │  │
│  │  │  (Swift, uses Core Bluetooth)       │  │  │
│  │  └────────────┬────────────────────────┘  │  │
│  └───────────────┼─────────────────────────────┘  │
│                  │                                │
│              📶 BLE                               │
│                  │                                │
└──────────────────▼────────────────────────────────┘
                   │
        ┌──────────┴──────────┐
        │   Whoop 4.0 strap   │
        └─────────────────────┘
```

The bridge module (`web/js/ble/capacitor-bridge.js`) synthesises a
Web-Bluetooth-compatible `navigator.bluetooth` on top of the Capacitor
plugin's API. The existing BLE client code (`web/js/ble/client.js`)
runs **unchanged** in both environments — Mac browser and iPhone native.
