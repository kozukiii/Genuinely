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

Every search goes through a four-stage pipeline before any listing is scored:

1. **Grouping** -- An 8b-instant LLM call groups listing titles by exact product (same brand, model, and variant) and assigns each group a data source: `pricecharting` for trading cards, `serper` for everything else. A parallel card-detection call overrides all groups to PriceCharting if the entire search query is card-based.

2. **Market data fetch** (per group, up to 2 concurrent) --
   - *PriceCharting path*: Serper searches for the card title and finds the PriceCharting item URL in organic results. The item page HTML is then scraped for loose, complete, new, and graded price cells plus the TCGPlayer row.
   - *Serper path*: Two parallel searches run -- one for resale pricing, one for buying-guide/inspection signals. Dollar amounts are extracted from snippets and trimmed to a p25–p75 range.

3. **Prompt engineering** -- A second 8b-instant call synthesises the raw market data into a product-specific expert system prompt with explicit `PRICE_LOW` / `PRICE_HIGH` anchors. Groups with PriceCharting data get the verified price prepended as an authoritative anchor so the scorer can't drift from it.

4. **LLM scoring** -- Groq scores each listing across all six dimensions using the engineered system prompt. Price fairness uses a deterministic percentile algorithm so scores don't drift with model temperature.

Results are cached in memory to avoid redundant LLM calls on repeated searches.

---

## Per-Category Price Sources

Genuinely's pricing layer is designed so each product category can use the best available market source. The grouping LLM assigns a source to every product group at query time -- currently `pricecharting` for trading cards (Pokémon, MTG, Yu-Gi-Oh, sports cards) and `serper` for everything else (electronics, golf clubs, sneakers, etc.).

For PriceCharting groups, the backend pipeline in `backend/src/ai/listingContext.ts`:

1. Strips condition keywords from the listing title to form a clean card search query.
2. Runs a Serper search for that query and looks for a `pricecharting.com/game/` URL in the organic results.
3. Scrapes the PriceCharting item page (`backend/src/priceSources/priceCharting.ts`) for the loose, complete, new, and graded price cells.
4. Reads the TCGPlayer row from that same page and extracts both the TCGPlayer market price and the destination URL.
5. For graded cards (PSA/BGS/CGC grade detected in the title), reads the grade-specific completed-auction section for a sale range instead of the standard price cells.
6. For ungraded cards, pairs the PriceCharting loose price with the TCGPlayer market price (falling back to complete or new price) to form the `priceLow`/`priceHigh` range.
7. Sends `priceLow`, `priceHigh`, `priceSource`, `priceChartingUrl`, and `tcgPlayerUrl` back through the scoring pipeline so the listing page can display source links next to the price bar.

TCGPlayer data is integrated via PriceCharting's item page HTML rather than a separate API call: PriceCharting includes a `TCGPlayer` source row with pricing and a product link in its markup, so the scraper parses that row directly.

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
