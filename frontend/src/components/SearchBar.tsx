import { useEffect, useState } from "react";
import "./styles/SearchBar.css";

interface Props {
  onSearch: (query: string) => void;
  initialQuery?: string;
  onLinkAnalysis?: () => void;
}

export default function SearchBar({ onSearch, initialQuery = "", onLinkAnalysis }: Props) {
  const [query, setQuery] = useState(initialQuery);

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  function submit() {
    onSearch(query);
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") submit();
  };

  return (
    <div className="search-bar-wrapper">
    <div className="search-bar">
      <input
        type="text"
        placeholder="Search for anything..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <button onClick={submit}>Search</button>
    </div>
    {onLinkAnalysis && (
      <button className="search-bar-link-btn" onClick={onLinkAnalysis}>
        Have a link for a listing that needs analysis?
      </button>
    )}
    </div>
  );
}
