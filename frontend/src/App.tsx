// src/App.tsx
import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import NavBar from "./components/NavBar";
import SignInToast from "./components/SignInToast";
import { AuthProvider } from "./context/AuthContext";

// Pages
import SearchPage from "./pages/SearchPage";
import CartPage from "./pages/CartPage";
import HomePage from "./pages/HomePage";
import ListingPage from "./pages/ListingPage";
import ListingCardDemo from "./pages/ListingCardDemo";

import "./pages/styles/HomePage.css";

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
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <NavBar />
        <AppRoutes />
        <SignInToast />
      </AuthProvider>
    </BrowserRouter>
  );
}
