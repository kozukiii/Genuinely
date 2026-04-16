import React, { useEffect, useMemo, useRef, useState } from "react";
import "./styles/SearchBar.css";
import { getSavedListings } from "../utils/savedListings";
import { getRecentlyViewed } from "../utils/recentlyViewed";

const TRENDING = [
  "PS5 console", "Air Jordan 1", "iPhone 15 Pro", "RTX 4090",
  "Pokemon cards", "MacBook Air M3", "AirPods Pro", "Nintendo Switch OLED",
  "Rolex watch", "Lego Technic", "Sony camera", "Xbox Series X",
];

const RECENT_KEY = "search:recent:queries";

function getRecentQueries(): string[] {
  try { return JSON.parse(sessionStorage.getItem(RECENT_KEY) ?? "[]"); }
  catch { return []; }
}

export function saveRecentQuery(q: string) {
  try {
    const prev = getRecentQueries().filter(r => r.toLowerCase() !== q.toLowerCase());
    sessionStorage.setItem(RECENT_KEY, JSON.stringify([q, ...prev].slice(0, 8)));
  } catch {}
}

function HighlightMatch({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="suggestion-highlight">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}

function truncate(s: string, n = 48) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

interface Suggestion {
  text: string;
  display: string;
  icon: string;
  section: string;
}

interface Props {
  onSearch: (query: string) => void;
  initialQuery?: string;
  onLinkAnalysis?: () => void;
}

export default function SearchBar({ onSearch, initialQuery = "", onLinkAnalysis }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [focused, setFocused] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setQuery(initialQuery); }, [initialQuery]);

  const suggestions = useMemo((): Suggestion[] => {
    const q = query.trim().toLowerCase();
    const recentSearches = getRecentQueries();
    const viewed = getRecentlyViewed();
    const saved = getSavedListings();

    const match = (s: string) => !q || s.toLowerCase().includes(q);

    if (!q) {
      // Default: trending + viewed titles + saved titles
      const results: Suggestion[] = [];

      TRENDING.slice(0, 6).forEach(t =>
        results.push({ text: t, display: t, icon: "↑", section: "Trending" })
      );
      viewed.slice(0, 3).forEach(l =>
        results.push({ text: l.title, display: truncate(l.title), icon: "👁", section: "Recently Viewed" })
      );
      saved.slice(0, 3).forEach(l =>
        results.push({ text: l.title, display: truncate(l.title), icon: "♥", section: "Saved" })
      );

      return results;
    }

    // Typing: filter each source
    const results: Suggestion[] = [];

    recentSearches.filter(match).slice(0, 3).forEach(r =>
      results.push({ text: r, display: r, icon: "🕐", section: "Recent" })
    );
    TRENDING.filter(t => match(t) && !recentSearches.some(r => r.toLowerCase() === t.toLowerCase()))
      .slice(0, 4).forEach(t =>
        results.push({ text: t, display: t, icon: "↑", section: "Trending" })
      );
    viewed.filter(l => match(l.title)).slice(0, 2).forEach(l =>
      results.push({ text: l.title, display: truncate(l.title), icon: "👁", section: "Recently Viewed" })
    );
    saved.filter(l => match(l.title) && !viewed.some(v => v.id === l.id && v.source === l.source))
      .slice(0, 2).forEach(l =>
        results.push({ text: l.title, display: truncate(l.title), icon: "♥", section: "Saved" })
      );

    return results;
  }, [query]);

  const showDropdown = focused && suggestions.length > 0;

  function submit(q: string) {
    const trimmed = q.trim();
    if (!trimmed) return;
    saveRecentQuery(trimmed);
    onSearch(trimmed);
    setFocused(false);
    setActiveIdx(-1);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, suggestions.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, -1)); }
    else if (e.key === "Enter") { e.preventDefault(); submit(activeIdx >= 0 ? suggestions[activeIdx].text : query); }
    else if (e.key === "Escape") { setFocused(false); setActiveIdx(-1); }
  }

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setFocused(false); setActiveIdx(-1);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Build rows with section headers
  const rows: React.ReactNode[] = [];
  let lastSection = "";
  suggestions.forEach((s, i) => {
    if (s.section !== lastSection) {
      rows.push(<div key={`sec-${s.section}`} className="suggestion-section">{s.section}</div>);
      lastSection = s.section;
    }
    rows.push(
      <button
        key={`${s.section}-${s.text}`}
        className={`suggestion-item${i === activeIdx ? " suggestion-item--active" : ""}`}
        onMouseDown={(e) => { e.preventDefault(); submit(s.text); }}
        onMouseEnter={() => setActiveIdx(i)}
      >
        <span className="suggestion-icon">{s.icon}</span>
        <span className="suggestion-text">
          <HighlightMatch text={s.display} query={query} />
        </span>
      </button>
    );
  });

  return (
    <div className="search-bar-wrapper" ref={wrapperRef}>
      <div className={`search-bar${showDropdown ? " search-bar--open" : ""}`}>
        <input
          type="text"
          placeholder="Search for anything..."
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActiveIdx(-1); }}
          onFocus={() => setFocused(true)}
          onKeyDown={handleKeyDown}
        />
        <button onClick={() => submit(query)}>Search</button>
      </div>

      {showDropdown && (
        <div className="suggestions-dropdown">{rows}</div>
      )}

      {onLinkAnalysis && (
        <button className="search-bar-link-btn" onClick={onLinkAnalysis}>
          Have a listing link that needs analysis?
        </button>
      )}
    </div>
  );
}
