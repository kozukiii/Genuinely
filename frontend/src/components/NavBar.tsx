import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import "./styles/NavBar.css";
import { getEbayNotice, onEbayNoticeChange } from "../utils/ebayNotice";

export default function NavBar() {
  const { pathname } = useLocation();
  const [showEbayNotice, setShowEbayNotice] = useState(false);

  useEffect(() => {
    setShowEbayNotice(getEbayNotice());
    return onEbayNoticeChange(setShowEbayNotice);
  }, []);

  return (
    <nav className="navbar">
      <div className="nav-left">
        <Link to="/" className="nav-logo">
          Genuinely
        </Link>
      </div>

      {showEbayNotice && (
        <div className="nav-notice" role="status" aria-live="polite">
          There is an issue with eBay searching right now. Marketplace fallback is active where possible. Message Zach @ admin.genuinely@gmail.com.
        </div>
      )}

      <div className="nav-right">
        <Link
          to="/"
          className={pathname === "/" ? "nav-item active" : "nav-item"}
        >
          Home
        </Link>

        <Link
          to="/search"
          className={pathname === "/search" ? "nav-item active" : "nav-item"}
        >
          Search
        </Link>

        <Link
          to="/cart"
          className={pathname === "/cart" ? "nav-item active" : "nav-item"}
        >
          Saved
        </Link>
      </div>
    </nav>
  );
}
