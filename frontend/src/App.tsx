// src/App.tsx
import { BrowserRouter, Routes, Route } from "react-router-dom";
import NavBar from "./components/NavBar";

// Pages
import SearchPage from "./pages/SearchPage";
import CartPage from "./pages/CartPage";
import HomePage from "./pages/HomePage";
import ListingPage from "./pages/ListingPage";

import "./pages/styles/HomePage.css";

export default function App() {
  return (
    <BrowserRouter>
      <NavBar />

      <Routes>
        {/* Home */}
        <Route path="/" element={<HomePage />} />

        {/* Search & cart */}
        <Route path="/search" element={<SearchPage />} />
        <Route path="/cart" element={<CartPage />} />

        {/* Individual listing */}
        <Route path="/listing/:id" element={<ListingPage />} />
      </Routes>
    </BrowserRouter>
  );
}
