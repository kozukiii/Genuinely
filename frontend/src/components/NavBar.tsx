import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import "./styles/NavBar.css";
import { getSavedListings } from "../utils/savedListings";
import { useAuth } from "../context/AuthContext";

function GenuinelyLogo() {
  return (
    <svg
      className="nav-logo-mark"
      viewBox="0 0 44 44"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#3dff8f" />
          <stop offset="100%" stopColor="#1aad54" />
        </linearGradient>
      </defs>
      <circle cx="22" cy="22" r="18.5" stroke="url(#ringGrad)" strokeWidth="3.5" />
      <text
        x="22"
        y="29"
        textAnchor="middle"
        fill="white"
        fontFamily="system-ui, -apple-system, sans-serif"
        fontWeight="700"
        fontSize="20"
      >
        G
      </text>
    </svg>
  );
}

export default function NavBar() {
  const { pathname } = useLocation();
  const { user, loading, login, logout } = useAuth();
  const [savedCount, setSavedCount] = useState(() => getSavedListings().length);

  useEffect(() => {
    const update = () => setSavedCount(getSavedListings().length);
    window.addEventListener("saved:listings:changed", update);
    return () => window.removeEventListener("saved:listings:changed", update);
  }, []);

  return (
    <header className="navbar-wrapper">
      <nav className="navbar">
        <Link to="/" className="nav-logo" aria-label="Genuinely home">
          <GenuinelyLogo />
          <span className="nav-logo-text">
            <span className="nav-logo-name">GENUINELY</span>
            <span className="nav-logo-tagline">SHOP GENUINELY</span>
          </span>
        </Link>

        <div className="nav-links-pill">
          <Link to="/" className={pathname === "/" ? "nav-item active" : "nav-item"}>
            Home
          </Link>
          <Link to="/search" className={pathname === "/search" ? "nav-item active" : "nav-item"}>
            Search
          </Link>
          <Link to="/cart" className={pathname === "/cart" ? "nav-item active" : "nav-item"}>
            Saved{savedCount > 0 && <span className="nav-saved-count">{savedCount}</span>}
          </Link>
        </div>

        <div className="nav-auth">
          {!loading && (
            user
              ? (
                <button
                  type="button"
                  className="nav-auth-avatar"
                  onClick={() => logout()}
                  title={`Signed in as ${user.email}`}
                  aria-label="Sign out"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
                    <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/>
                  </svg>
                  <span className="nav-auth-label">Sign out</span>
                </button>
              )
              : (
                <div className="nav-auth-pill">
                  <button type="button" className="nav-item nav-signin" onClick={login}>
                    Sign in
                  </button>
                </div>
              )
          )}
        </div>
      </nav>

    </header>
  );
}
