# Nintendo Switch Online (NSO) WebApp

A modern, responsive Web Application port of the official Nintendo Switch Online (Coral) App.

Live Site: [https://dycool.github.io/nso-webapp/](https://dycool.github.io/nso-webapp/)

---

## 🌟 Features

- **Friends List & Online Presence**: Live online status, played games, and Friend Codes.
- **All account game services**: Loads Nintendo's current
  `/v4/GameWebService/List` catalog, obtains a short-lived token for the chosen
  service, and launches its real Nintendo WebView through the Worker. This
  includes Zelda Notes, SplatNet 3, NookLink, Smash World, SplatNet 2, and
  future catalog services when they are available for the signed-in account.
- **Switch Media & Album Gallery**: Browse and play uploaded screenshots and
  videos, inspect capture metadata, share links, and download captures.
- **Public nxapi ZNCA API**: Generates the Coral `f`, timestamp, and request ID,
  and encrypts/decrypts Coral API traffic.
- **CORS and WebView relay**: Connects to
  `nso-worker-backend.diogoenes0.workers.dev` because Nintendo and nxapi do not
  permit browser CORS requests. Game tokens are kept in an HTTP-only,
  short-lived first-party relay cookie and are never stored by the Worker.

---

## 🚀 Live Demo & Deployment

This WebApp is automatically deployed to **GitHub Pages**:
- **URL**: [https://dycool.github.io/nso-webapp/](https://dycool.github.io/nso-webapp/)

## nxapi setup

The webapp uses the public `nxapi-znca-api` service with its registered
**nxapi-auth public client ID**. The production client ID is part of the
application configuration and is not editable by visitors. For local
development, register a separate public client with the scopes
`ca:gf ca:er ca:dr` at [nxapi-auth](https://nxapi-auth.fancy.org.uk/oauth/clients)
and set `window.NXAPI_AUTH_CLIENT_ID` before loading `app.js`.

Before sign-in, the webapp requires an explicit acknowledgement that the
Nintendo Account ID token, Coral token, and Coral API traffic are sent to the
third-party nxapi ZNCA API. The short-lived nxapi access token is kept in memory
only; it is not written to browser storage. For local development, register and
use a separate nxapi-auth public client ID instead of the production client ID.

No Android emulator, Frida process, or local `f` service is needed. The app
loads the public API's current supported Coral version before authentication.

For a different nxapi ZNCA deployment, set `window.NXAPI_ZNCA_API_URL` before
loading `app.js`. The CORS relay must explicitly allow that host.
