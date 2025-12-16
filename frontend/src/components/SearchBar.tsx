import { useEffect, useState } from "react";
import "./styles/SearchBar.css";

interface Props {
  onSearch: (query: string) => void;
  initialQuery?: string;
}

export default function SearchBar({ onSearch, initialQuery = "" }: Props) {
  const [query, setQuery] = useState(initialQuery);

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      onSearch(query);
    }
  };

  return (
    <div className="search-bar">
      <input
        type="text"
        placeholder="Search eBay listings..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}   
      />
      <button onClick={() => onSearch(query)}>Search</button>
    </div>
  );
}
