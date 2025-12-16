import { Link, useLocation } from "react-router-dom";
import "./styles/NavBar.css";

export default function NavBar() {
  const { pathname } = useLocation();

  return (
    <nav className="navbar">
      <div className="nav-left">
        <Link to="/" className="nav-logo">
          Genuinely™
        </Link>
      </div>

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
          Cart
        </Link>
      </div>
    </nav>
  );
}
