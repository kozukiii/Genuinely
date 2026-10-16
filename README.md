<div align="center">

# Genuinely

### AI-powered deal hunting across secondhand marketplaces

Genuinely helps shoppers search multiple marketplaces at once, compare listings faster, and understand whether an item is actually a good deal before clicking through. It combines marketplace data, price context, seller signals, and AI-generated listing analysis into a cleaner shopping experience.

**🌐 Live site → [www.genuinelyshop.com](https://www.genuinelyshop.com)**

![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?logo=nodedotjs&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind-06B6D4?logo=tailwindcss&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=white)

</div>

---

## 📖 Overview

Secondhand shopping is powerful, but it is also messy. Listings are scattered across platforms, prices vary wildly, descriptions are inconsistent, and buyers often have to do their own research before knowing whether something is worth pursuing.

**Genuinely is built to reduce that friction.**

The app searches supported marketplaces, organizes listing data, analyzes price fairness and trust signals, and summarizes the most important buying context in a simple interface.

---

## ✨ Features

- 🔎 **Unified marketplace search** across supported secondhand sources
- 🤖 **AI-assisted listing analysis** for faster decision-making
- 💲 **Price fairness scoring** using market context and deterministic pricing logic
- 🛡️ **Seller trust signals** based on available marketplace data
- 📝 **Condition and description review** to help surface listing quality
- 📦 **Shipping fairness analysis** where shipping data is available
- 🏷️ **Category-aware price sources** for more accurate pricing in supported categories
- 🔥 **Trending search shortcuts** for popular products
- 🎚️ **Filters** for price, condition, shipping, and location
- 💾 **Saved listings** synced to user accounts with guest fallback support — analysis-only persistence, with listing content re-fetched live on view
- 📊 **Listing detail pages** with a visual score breakdown and plain-English analysis
- 🖼️ **Image proxying** for cleaner and more reliable listing images
- 🎨 **eBay variation selector** for item-group listings — pick a specific color, size, or model before analyzing
- ♻️ **Availability checking** for saved listings, with TTL-based refresh so sold, ended, or removed listings surface automatically
- ⚡ **Sticky/racing proxy strategy** for marketplace fetches, for lower latency and more consistent access

---

## 🧱 Tech Stack

| Layer | Technology |
| --- | --- |
| **Frontend** | React, TypeScript, Vite, Tailwind CSS |
| **Backend** | Node.js, Express, TypeScript |
| **Database** | SQLite with better-sqlite3 |
| **Auth** | Google OAuth 2.0, JWT, HTTP-only cookies |
| **AI** | Groq API |
| **Marketplace Data** | eBay Browse API, marketplace integration services |
| **Search Fallback** | Serper API |
| **Price Sources** | Category-specific pricing integrations |
| **Geocoding** | OpenStreetMap Nominatim |
| **Deployment** | Vercel, Render |
| **Analytics** | Vercel Analytics, Speed Insights |

---

## 🗂️ Project Structure

```
Genuinely/
├── frontend/
│   └── src/
│       ├── components/
│       ├── pages/
│       ├── context/
│       └── utils/
│
└── backend/
    └── src/
        ├── ai/
        ├── controllers/
        ├── routes/
        ├── services/
        ├── middleware/
        └── utils/
```

---

## ⚙️ How It Works

Genuinely uses a multi-stage pipeline to turn raw marketplace listings into useful buying guidance.

1. **Collect & normalize** — the app gathers listings from supported sources and normalizes them into a shared format so results from different marketplaces can be compared in one interface.
2. **Gather market context** — the backend pulls price context for each product. Depending on the category, this may come from general search results, marketplace comparables, or more specific pricing sources.
3. **Score** — each listing is evaluated across several practical buying dimensions:
   - 💲 Price fairness
   - 🛡️ Seller trust
   - 📝 Condition honesty
   - 📦 Shipping fairness
   - 📄 Description quality

AI is used to explain and summarize listing quality, while deterministic logic is used where consistency matters most — especially for price fairness and seller trust calculations.

> The goal is not just to assign a score. The goal is to explain **why** a listing may be a good deal, overpriced, risky, or worth a closer look.

---

## 🔀 Marketplace Proxy Strategy

Marketplace search and listing-detail requests use the first proxy configured in `PROXY_URL` from the initial request. Direct egress is used only when no proxy is configured. Requests do not race other proxies or fall back to a different route after failure.

Use a complete HTTP(S) URL such as `http://USERNAME:PASSWORD@HOST:PORT`, with reserved characters in the credentials URL-encoded. Legacy `HOST:PORT:USERNAME:PASSWORD` strings are invalid. Startup diagnostics report URL validity and credential presence without printing credentials.

HTTP 401, 403, 407, 429 and GraphQL rate-limit code 1675004 stop requests and apply a shared cooldown across search and listing details. `Retry-After` is honored, with a 60-second default. Authorization and proxy-authentication failures require configuration review; changing routes is not used to work around them.

`PROXY_URL` is a **production-only** variable — local development normally runs without it. A comma-separated list remains accepted, but only its first entry is used.

---

## 🧠 AI Scoring

Genuinely uses structured AI responses to evaluate listings in a predictable format. Listing analysis is validated before being shown to users, which helps prevent malformed responses or unreliable score objects from reaching the frontend.

The backend includes safeguards for:

- Structured JSON output
- Score validation
- Score clamping
- Invalid field removal
- Fallback analysis states
- Deterministic overrides for key scoring fields

This keeps the AI layer useful without letting it fully control business-critical scoring.

---

## 💻 Local Development

This project requires private API credentials to run with full marketplace, auth, and AI functionality.

```bash
git clone https://github.com/kozukiii/genuinely.git
cd genuinely
npm install
npm run dev
```

Environment variables are required for the frontend and backend. Example files should be created as:

```
frontend/.env.example
backend/.env.example
```

The actual `.env` files are not committed.

---

## 🔐 Environment Variables

**Backend**

```env
GROQ_API_KEY=
EBAY_APP_ID=
EBAY_CERT_ID=
EBAY_DEV_ID=
EBAY_PROD_TOKEN=
EBAY_ENVIRONMENT=production
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=
JWT_SECRET=
ANALYSIS_SIGNING_SECRET=   # optional — falls back to JWT_SECRET if unset
SERPER_API_KEY=
PROXY_URL=                # production only — not required for local dev
ALLOWED_ORIGIN=
FRONTEND_URL=
PORT=3000
DATA_DIR=./data
```

**Frontend**

```env
VITE_API_BASE_URL=
```

---

## 🚀 Deployment

- The **frontend** is deployed on Vercel.
- The **backend** is deployed separately on Render.

SQLite persistence is handled through a configured backend data directory. Production secrets are managed through the hosting provider environment variable dashboards.

---

## 🛡️ Security

Genuinely includes several production hardening measures:

- Environment variables for secrets
- HTTP-only auth cookies
- JWT-based session handling
- CORS origin restrictions
- Rate limiting on public endpoints
- Helmet.js security headers
- Sanitized logging to avoid exposing sensitive tokens or credentials

### Server-signed analysis trust boundary

Listing analysis is treated as a server-controlled operation, so the client can never forge the data that drives AI scoring. When the backend returns listings, each one is stamped with an **HMAC-signed proof** (`analysisProof`) covering a canonical, derived-field-stripped representation of the listing, with a short expiry.

When a client requests analysis, the server **re-verifies that signature** before doing any work — any tampering with prices, condition, seller signals, or other listing fields invalidates the proof and the request is rejected. Trusted scoring inputs that must not be client-supplied (system prompt, price range, price source, shipping estimate) are kept server-side behind a **single-use, TTL-bound context token** that is bound to the exact set of listing keys it was issued for.

This keeps price fairness, trust scoring, and the AI prompt anchored to server-issued data rather than anything the browser sends, while signing keys are sourced from `ANALYSIS_SIGNING_SECRET` (falling back to `JWT_SECRET`).

### Saved-listings storage (analysis-only persistence)

Saved listings are persisted with a deliberate boundary: **the database stores only Genuinely's own analysis output plus the listing's identity — never the source platform's content.** When a user saves a listing, the server runs it through a strict field **allowlist** before writing to disk:

| Persisted | Never persisted |
| --- | --- |
| `id`, `source` (identity) | `title`, `description`, `fullDescription` |
| `score`, `aiScore`, `aiScores` | `images`, `seller`, `price`, `condition`, `url` |
| `overview`, `highlights` | any other source-supplied field |
| `priceLow`/`priceHigh`/`priceSource` (derived) | |
| availability metadata | |

The allowlist lives in `savedRoutes.ts` (`ALLOWED_FIELDS`); a guarded one-time migration in `db.ts` scrubbed any pre-existing rows down to the same shape.

Because the persisted record is just scores + an identity, the saved view is hydrated in two layers:

1. **localStorage** keeps the full listing as a per-browser convenience cache, so everyday rendering is instant and offline-friendly.
2. On a device with no local cache (e.g. fresh login), the client calls `POST /api/saved/hydrate`, which **re-fetches live listing content by `source` + `id`** from the source platform at view time. The fetched content is held only in the client; the stored analysis is then re-applied on top so scores always win.

The net effect: listing content is always read live and never retained server-side, while the user's saved scores and analysis persist across devices.

---

## 📌 Current Status

Genuinely is an active portfolio and product project. The live version focuses on proving the core experience: **faster secondhand search, clearer listing analysis, and better price confidence for shoppers.**

Planned improvements include broader category-specific pricing, stronger marketplace coverage, improved ranking, and deeper personalization for saved listings.

---

## 👤 Author

**Built by Zach Higdon.**

Software Development student focused on full-stack development, product thinking, marketplace systems, and practical AI integrations.

## Search pagination

`GET /api/search` keeps its listing-array response and returns continuation headers:
`X-Search-Has-More` and `X-Search-Next-Offset`. The next request must use the returned
raw eBay offset, not the number of displayed listings. These headers and the two
source-status headers are exposed through CORS. Continuation requests also send
`continuation=1`, including retries at offset zero, so Marketplace is fetched only
for the initial request. Deploy this backend contract before
the updated frontend; a frontend served against an older backend shows a retryable
pagination error rather than guessing that results are exhausted.

Search scans fixed 50-summary eBay windows, excluding variations before detail
requests and validating again after details. It stops after five windows per request;
a short or empty filtered batch can therefore still have more results. Initial
source searches run concurrently; if Marketplace returns fewer rows, eBay refills
from its cursor within the same scan budget. Marketplace never contributes to the
eBay cursor. Source failures retain a retry cursor and are reported separately from
normal exhaustion.
The browser saves continuation state with the cached search; caches predating this
contract restart the search because their listing counts cannot reconstruct a cursor.

Pagination checks: `npm test --prefix backend` and `npm test --prefix frontend`.

## Marketplace response diagnostics

`[marketplace:response]` records a request ID, direct/proxy route, nonsecret proxy
index, configured proxy count, authentication-presence flags, HTTP status, media
type, and response classification. It never logs proxy URLs, credentials, cookie
or challenge-header values, GraphQL error messages, or response bodies.

Explicit access denials stop the current request and pending race candidates;
they do not trigger another proxy or direct attempt. Authentication denials trigger
a 60-second cooldown and a configuration-review diagnostic. HTTP 429 and the
observed GraphQL rate-limit code honor `Retry-After` or use a 60-second cooldown;
requests during that interval do not call the upstream service. Diagnostics are
single-line JSON. Pagination and source-status headers are unchanged.
