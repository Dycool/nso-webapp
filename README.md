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
  permit browser CORS requests. Short-lived account/game-service tokens are
  handled by the account-scoped Worker broker and are removed when the user
  signs out; nxapi OAuth tokens remain browser-memory-only.

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

No Android emulator, Frida process, or local `f` service is needed. The webapp
pins the Nintendo Switch App version to the Coral session that created its
tokens; it never changes `X-znca-Version` underneath an active nxapi/Coral
context.

For a different nxapi ZNCA deployment, set `window.NXAPI_ZNCA_API_URL` before
loading `app.js`. The CORS relay must explicitly allow that host.

---

## License and Nintendo notice

The project's original source code is available under the [MIT License](./LICENSE).
That license applies only to code and other material authored for this project.

This is an unofficial interoperability project and is not affiliated with,
endorsed by, sponsored by, or approved by Nintendo. Nintendo, Nintendo Switch,
Nintendo Switch App, and related names, logos, game-service content, APIs, and
other Nintendo-owned material remain the property of their respective owners
and are not granted under this project's MIT License.

A software license governs reuse of this project's own code; it does not waive
or prevent any rights or claims a third party may have in its trademarks,
copyrighted material, services, or agreements.

## Caching and request budget

The browser locally caches app settings, selected language, short-lived Coral read
results, and image/static assets so repeat navigation normally does not need to hit
the Worker. Nintendo/Coral and nxapi authentication tokens are never written into
that response cache. Cached account API data is removed on Sign Out. Nintendo, nxapi,
authentication, mutation, and game-service API traffic is never placed in a shared
browser or CDN cache.

Coral request encryption, the Nintendo API call, and response decryption are grouped
into one browser-to-Worker request when an account broker session is available. The
Worker does not persist the request-local nxapi OAuth token. Current clients do not send periodic account-broker heartbeats. Normal broker operations
refresh the lease, stale ephemeral leases expire server-side, and explicit Sign Out
performs immediate destructive cleanup.
