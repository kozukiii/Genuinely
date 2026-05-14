# Genuinely

**AI-powered deal hunting across eBay and Facebook Marketplace.**

Genuinely searches multiple marketplaces simultaneously, scores every listing with an LLM, and gives you a straight answer: is this a good deal or not? Price fairness, seller trust, condition honesty, shipping costs, and more -- all surfaced before you click Buy.

---

## Features

- **Unified search** -- query eBay and Facebook Marketplace at the same time, deduplicated
- **AI scoring** -- each listing gets scored across 6 dimensions using Groq's LLM inference
  - Price fairness (deterministic percentile algorithm + market context)
  - Seller trust (feedback history analysis)
  - Condition honesty (description vs. stated condition)
  - Shipping fairness (cost vs. item value)
  - Location risk (pickup vs. shipping logistics)
  - Description quality (detail and accuracy)
- **Market context** -- pulls comparable listings to build real price ranges before scoring
- **Per-category price sources** -- continually expanding source integrations let category-specific data override generic web estimates when a better source exists
- **Trending shortcuts** -- one-click searches for PS5, Nintendo Switch, Air Jordan 1, and more
- **Filters** -- price range, condition, free shipping, location
- **Save listings** -- synced to your account via SQLite, falls back to LocalStorage
- **Link analysis** -- paste any listing URL for on-demand AI scoring
- **Admin dashboard** -- API usage monitoring for eBay, Groq, and Serper providers
- **Image proxy** -- high-res variants, proxied cleanly through the backend

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS 4 |
| Backend | Express 5, TypeScript, Node.js |
| Database | SQLite via better-sqlite3 (WAL mode) |
| Auth | Google OAuth 2.0 + JWT (HTTP-only cookies) |
| AI/LLM | Groq API (OpenAI-compatible endpoint) |
| Marketplaces | eBay Browse API v1, Facebook Marketplace GraphQL |
| Search fallback | Serper API |
| Category price sources | PriceCharting, TCGPlayer data exposed through PriceCharting item pages |
| Geocoding | OpenStreetMap Nominatim |
| Deployment | Vercel (frontend), Render (backend) |
| Analytics | Vercel Analytics + Speed Insights |

---

## Project Structure

```
Genuinely/
├── frontend/               # React SPA
│   └── src/
│       ├── components/     # NavBar, ListingCard, RatingRing, filters, etc.
│       ├── pages/          # HomePage, SearchPage, ListingPage, CartPage, AdminPage
│       ├── context/        # AuthContext (Google OAuth state)
│       └── utils/          # savedListings, searchCache, analysisStore, imageHelpers
│
└── backend/                # Express API
    └── src/
        ├── ai/             # Groq batch analysis, market context fetching
        ├── controllers/    # Search orchestration, eBay, Marketplace
        ├── routes/         # auth, search, ebay, marketplace, saved, image proxy, admin
        ├── services/       # aiService, ebayService, marketplaceService, scoring/
        ├── middleware/      # JWT verification, admin guard
        └── utils/          # extractStructuredAnalysis, mapEbaySummary, geoIp, etc.
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+
- API keys for: Groq, eBay (App ID, Cert ID, Dev ID, Prod Token), Google OAuth, Serper
- (Optional) Proxy URL for Facebook Marketplace scraping

### 1. Clone and install

```bash
git clone https://github.com/kozukiii/genuinely.git
cd genuinely
npm install
cd frontend && npm install
cd ../backend && npm install
```

### 2. Configure environment

Create `backend/.env`:

```env
# LLM
GROQ_API_KEY=your_groq_key

# eBay
EBAY_APP_ID=
EBAY_CERT_ID=
EBAY_DEV_ID=
EBAY_PROD_TOKEN=
EBAY_ENVIRONMENT=production

# Google OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback
JWT_SECRET=your_jwt_secret

# Serper (web search fallback)
SERPER_API_KEY=

# App config
ALLOWED_ORIGIN=http://localhost:5173
FRONTEND_URL=http://localhost:5173
PORT=3000

# Proxy for Facebook Marketplace (optional, comma-separated)
PROXY_URL=

# SQLite location (default: ./data)
DATA_DIR=./data
```

Create `frontend/.env`:

```env
VITE_API_BASE_URL=http://localhost:3000
```

### 3. Run in development

```bash
# From the root
npm run dev
```

This starts both the backend (port 3000) and frontend (port 5173) concurrently.

---

## API Reference

| Method | Route | Description |
|---|---|---|
| `POST` | `/auth/google` | Initiate Google OAuth |
| `GET` | `/auth/google/callback` | OAuth callback |
| `GET` | `/auth/me` | Current user + admin flag |
| `POST` | `/auth/logout` | Clear auth cookie |
| `GET` | `/api/search` | Multi-source search (`?query=&sources=ebay,marketplace&analyze=1`) |
| `GET` | `/api/marketplace/item/:id` | Single Marketplace listing detail |
| `GET` | `/api/proxy-image` | Image proxy (`?url=`) |
| `GET` | `/api/featured` | Admin-curated featured listings |
| `GET` | `/api/saved` | User's saved listings |
| `POST` | `/api/saved` | Save a listing |
| `DELETE` | `/api/saved/:id` | Remove a saved listing |
| `POST` | `/api/internal/admin/usage` | API usage stats (admin only) |
| `GET` | `/api/health` | Health check |

---

## How the Scoring Works

Every listing goes through a two-stage pipeline:

1. **Market context** -- Serper fetches comparable sold listings to build a real price distribution for the item.
2. **LLM analysis** -- Groq scores the listing across all six dimensions given the market context. Price fairness uses a deterministic percentile algorithm so scores are consistent and don't drift with model temperature.

Results are cached in memory to avoid redundant LLM calls on repeated searches.

---

## Per-Category Price Sources

Genuinely's pricing layer is being updated continually so each category can use the best available market source instead of relying only on broad search snippets. The current implemented path is for video games and trading cards, where the prompt-engineering step can set `USE_PRICECHARTING: true` and route that product group through PriceCharting before scoring.

For those groups, the backend:

1. Groups listings by canonical product name in `backend/src/ai/listingContext.ts`.
2. Uses Serper/Groq to build the product-specific scoring prompt and decide which source should be used. (eg. pricecharting.com)
3. Calls `findPriceChartingMatch(...)` in `backend/src/priceSources/priceCharting.ts`.
4. Tries PriceCharting direct URLs first, then falls back to PriceCharting search queries.
5. Reads PriceCharting's item page HTML for the loose, complete, new, and graded price cells.
6. Reads the TCGPlayer row from that same PriceCharting HTML and extracts both the TCGPlayer market price and destination URL.
7. Sends `priceLow`, `priceHigh`, `priceSource`, `priceChartingUrl`, and `tcgPlayerUrl` back through the search analysis routes so the listing page can show the source links next to the price bar.

TCGPlayer is integrated this way because its data is already exposed inside PriceCharting's item page HTML. While testing PriceCharting pages, I noticed a `TCGPlayer` source row and TCGPlayer product links in the markup, so the implementation parses that row instead of adding a separate TCGPlayer API path. For raw cards, the authoritative range is built from PriceCharting loose price plus TCGPlayer market price. For graded cards, PriceCharting's grade-specific price becomes the high anchor, with the raw TCGPlayer value used as the lower reference when available.

---

## Deployment

**Frontend** is deployed to Vercel. Push to `master` and Vercel handles it automatically via `vercel.json`.

**Backend** is deployed to Render. Set all environment variables in the Render dashboard. The SQLite database persists to the `DATA_DIR` path -- use a Render disk mount for durability.

---

## Security

- API keys stored in `.env`, never committed
- HTTP-only cookies prevent XSS token theft
- Rate limiting: 30 requests per 5 minutes on most endpoints
- CORS restricted to configured `ALLOWED_ORIGIN`
- Helmet.js hardens HTTP headers
- Facebook scraping routed through proxy rotation to avoid IP blocks
