// src/App.tsx
import { useEffect } from "react";
import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import NavBar from "./components/NavBar";
import SignInToast from "./components/SignInToast";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { refreshSavedListingsHealthCheck } from "./utils/savedListings";

// Pages
import SearchPage from "./pages/SearchPage";
import CartPage from "./pages/CartPage";
import HomePage from "./pages/HomePage";
import ListingPage from "./pages/ListingPage";
import ListingCardDemo from "./pages/ListingCardDemo";
import SearchPageDemo from "./pages/SearchPageDemo";
import AdminPage from "./pages/AdminPage";
import EbaySoldPricesPage from "./pages/EbaySoldPricesPage";
import PriceChartingDebugPage from "./pages/PriceChartingDebugPage";
import SerperSourceMatchDemoPage from "./pages/SerperSourceMatchDemoPage";
import StockXDebugPage from "./pages/StockXDebugPage";
import GridStitchDebugPage from "./pages/GridStitchDebugPage";
import EbayBatchTestPage from "./pages/EbayBatchTestPage";

import "./pages/styles/HomePage.css";

const WARMUP_START_DELAY_MS = 2000;
const WARMUP_RETRY_DELAY_MS = 1000;
const WARMUP_MAX_ATTEMPTS = 5;

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function SessionListingHealthCheck() {
  const { pathname } = useLocation();
  const { loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    refreshSavedListingsHealthCheck().catch(() => {});
  }, [loading, pathname]);

  return null;
}

function AppRoutes() {
  const location = useLocation();
  return (
    <Routes>
      {/* Home */}
      <Route path="/" element={<HomePage />} />

      {/* Search & cart */}
      <Route path="/search" element={<SearchPage />} />
      <Route path="/cart" element={<CartPage />} />

      {/* Individual listing — key forces full remount when navigating between listings */}
      <Route path="/listing/:id" element={<ListingPage key={location.pathname} />} />
      <Route path="/listingcard-demo" element={<ListingCardDemo />} />
      <Route path="/search-demo" element={<SearchPageDemo />} />
      <Route path="/admin" element={<AdminPage />} />
      <Route path="/admin/ebay-sold-prices" element={<EbaySoldPricesPage />} />
      <Route path="/admin/pricecharting-debug" element={<PriceChartingDebugPage />} />
      <Route path="/admin/serper-source-match" element={<SerperSourceMatchDemoPage />} />
      <Route path="/admin/stockx-debug" element={<StockXDebugPage />} />
      <Route path="/admin/grid-stitch" element={<GridStitchDebugPage />} />
      <Route path="/admin/ebay-batch-test" element={<EbayBatchTestPage />} />
    </Routes>
  );
}

export default function App() {
  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof window.setTimeout> | null = null;

    const scheduleWarmup = (delayMs: number, attempt: number) => {
      timeoutId = window.setTimeout(async () => {
        if (cancelled) return;

        try {
          const health = await fetch("/api/health", { cache: "no-store" });
          if (!health.ok) throw new Error("Backend health check failed");

          await fetch("/api/search/warmup", { cache: "no-store" });
        } catch {
          if (!cancelled && attempt < WARMUP_MAX_ATTEMPTS) {
            scheduleWarmup(WARMUP_RETRY_DELAY_MS, attempt + 1);
          }
        }
      }, delayMs);
    };

    scheduleWarmup(WARMUP_START_DELAY_MS, 1);

    return () => {
      cancelled = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, []);

  return (
    <BrowserRouter>
      <AuthProvider>
        <ScrollToTop />
        <SessionListingHealthCheck />
        <NavBar />
        <AppRoutes />
        <SignInToast />
      </AuthProvider>
    </BrowserRouter>
  );
}
