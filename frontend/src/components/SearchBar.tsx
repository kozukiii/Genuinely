import { useEffect, useState } from "react";
import "./SearchBar.css";

interface Props {
  onSearch: (query: string) => void;
    initialQuery?: string;
}

export default function SearchBar({ onSearch, initialQuery = "" }: Props) {
  const [query, setQuery] = useState(initialQuery);

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);
  return (
    <div className="search-bar">
      <input
        type="text"
        placeholder="Search eBay listings..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <button onClick={() => onSearch(query)}>Search</button>
    </div>
  );
}
