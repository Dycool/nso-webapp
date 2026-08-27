<p align="center">
  <img src="favicon.svg" alt="Nintendo Switch Online WebApp icon" width="128" height="128">
</p>

# Nintendo Switch Online (NSO) WebApp

**A modern, responsive, and feature-complete Web Application port of the official Nintendo Switch Online (Coral) App.**

🌐 **Live WebApp**: **[https://dycool.github.io/nso-webapp/](https://dycool.github.io/nso-webapp/)**

---

## 🌟 Key Features

👥 **Friends List & Online Presence** — View real-time friend online status, currently played games, friend requests, and copy Friend Codes with one click.

🎮 **Game Web Services** — Complete integration with official Nintendo Game Web Services, including **Zelda Notes**, **SplatNet 3**, **NookLink (Animal Crossing: New Horizons)**, **Smash World (Super Smash Bros. Ultimate)**, **SplatNet 2**, and all catalog services from Nintendo's `/v4/GameWebService/List`.

📸 **Switch Media & Album Gallery** — Browse and play uploaded screenshots and gameplay videos, view capture metadata, download zip archives, and share captures.

🧩 **Dual-Mode Backend Architecture** — Automatically connects to the local **[NSO Extension Backend](https://github.com/Dycool/nso-extension-backend)** for 100% direct PC-to-Nintendo communication, or seamlessly falls back to the stateless external server relay.

🌍 **Full 15-Language Localization** — Native interface translation across English (US/GB), Japanese, Spanish (ES/MX), French (FR/CA), Portuguese, German, Italian, Dutch, Russian, Korean, and Traditional/Simplified Chinese.

🔐 **Secure & Encrypted Sessions** — Encrypted Remember Me credential storage with automated session restoration, token renewal, and zero token leakage.

---

## 🚀 Live Demo & Installation

### Option 1: WebApp with Browser Extension (Recommended)
1. Install the **[NSO Extension Backend](https://github.com/Dycool/nso-extension-backend/releases/latest)** for direct PC-to-Nintendo proxying.
2. Open the **[Live WebApp](https://dycool.github.io/nso-webapp/)**.
3. The app will automatically connect in `🟢 NSO Extension` mode.

### Option 2: Zero-Install Web Mode
1. Navigate directly to **[https://dycool.github.io/nso-webapp/](https://dycool.github.io/nso-webapp/)**.
2. Sign in with your Nintendo Account — traffic will route through the external server relay.

---

## 🛠️ Architecture & Backend Modes

```
+-----------------------------------------------------------------------+
|                       NSO WebApp (Browser Frontend)                  |
+------------------------------------+----------------------------------+
                                     |
           +-------------------------+-------------------------+
           | (Detected)                                        | (Fallback)
           v                                                   v
+------------------------------------+   +------------------------------------+
|    NSO Extension Backend (MV3)     |   |    NSO Worker Backend (Cloudflare) |
|  - 100% Direct Local PC Proxy      |   |  - Stateless CORS Relay            |
|  - DeclarativeNetRequest Headers   |   |  - Web Crypto Session Encryption   |
|  - Injected Native znca Bridge     |   |  - Reverse-Proxied Game WebViews   |
+------------------+-----------------+   +------------------+-----------------+
                   |                                        |
                   +-------------------+--------------------+
                                       |
                                       v
                   +----------------------------------------+
                   |  Nintendo & nxapi Coral APIs           |
                   |  - accounts.nintendo.com               |
                   |  - api-lp1.znc.srv.nintendo.net       |
                   |  - nxapi-znca-api.fancy.org.uk         |
                   +----------------------------------------+
```

### 1. NSO Browser Extension Mode
* Operates locally with **zero external server dependencies**.
* Uses Manifest V3 `declarativeNetRequest` to dynamically strip frame headers and inject `X-GameWebToken` credentials into official Nintendo game iframes.
* Injects the native mobile JavaScript bridge (`window.webkit.messageHandlers.invokeMethod`) in `world: "MAIN"` at `document_start`.

### 2. External Server Relay Mode
* Relays browser requests that Nintendo and public nxapi services do not permit directly through CORS.
* All proxied responses containing sensitive tokens enforce `Cache-Control: no-store`.

---

## 🔐 nxapi & Privacy

The WebApp utilizes the public `nxapi-znca-api` service for Nintendo Switch Online Coral request attestation (`f` generation) and request encryption/decryption:
* **Explicit User Acknowledgement**: The WebApp requires user acknowledgement before authenticating.
* **Ephemeral Memory Only**: Short-lived nxapi OAuth access tokens remain strictly in browser memory and are never persisted to disk or shared caches.
* **No Emulators Required**: No Android emulator or local Frida server is required.

---

## 📂 Project Structure

```text
nso-webapp/
├── index.html              # Main HTML entrypoint and navigation shell
├── favicon.svg             # Application vector icon
├── css/
│   ├── base.css            # Design tokens, themes, typography, and reset
│   ├── auth.css            # Nintendo Account login view and modals
│   ├── layout.css          # Viewport layout and responsive containers
│   ├── shell.css           # Navigation bar, bottom tabs, and headers
│   ├── friends.css         # Friends list, presence cards, and profiles
│   ├── album.css           # Media grid, lightbox viewer, and downloaders
│   └── screens.css         # Settings and secondary feature sub-pages
├── js/
│   ├── localization.js     # Multilingual dictionary & translation engine (15 locales)
│   ├── core.js             # Shared state, backend auto-detection, and helpers
│   ├── health.js           # Network transport, retry engine, and preflight shims
│   ├── auth.js             # OAuth token pipeline and nxapi client credentials
│   ├── signin.js           # Nintendo Account login flow & session management
│   ├── coral.js            # Nintendo Coral API client and cache layer
│   ├── friends.js          # Friends list controller and presence handlers
│   ├── album.js            # Switch Album controller and media viewer
│   ├── ui.js               # Tab navigation, view router, and UI transitions
│   └── native.js           # Nintendo app parity controller, voice chat, and settings
└── services/
    ├── adapters.js         # Game service quirks and authentication adapters
    └── manager.js          # Game WebView iframe launcher and bridge manager
```

---

## 📜 Local Development

Run the web application locally with any static web server:

```bash
# Using Node.js built-in server or npx serve
npx serve . -l 8080
```

Open `http://localhost:8080` in your browser.

---

## 📄 License & Nintendo Notice

The project's original source code is available under the [MIT License](LICENSE).

This is an unofficial interoperability project and is not affiliated with, endorsed by, sponsored by, or approved by Nintendo. Nintendo, Nintendo Switch, Nintendo Switch Online, Coral, and related names, logos, game-service content, and APIs remain the property of their respective owners.