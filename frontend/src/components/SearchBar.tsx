import { useEffect, useState } from "react";
import "./styles/SearchBar.css";

interface Props {
  onSearch: (query: string, limit?: number) => void;
  initialQuery?: string;
}

export default function SearchBar({ onSearch, initialQuery = "" }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [limit, setLimit] = useState<string>("");

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  function submit() {
    const parsedLimit = limit !== "" ? Math.max(1, parseInt(limit, 10)) : undefined;
    onSearch(query, parsedLimit);
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") submit();
  };

  return (
    <div className="search-bar">
      <input
        type="text"
        placeholder="Search for anything..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <input
        className="search-bar-limit"
        type="number"
        placeholder="Limit"
        min={1}
        value={limit}
        onChange={(e) => setLimit(e.target.value)}
        onKeyDown={handleKeyDown}
        title="Max results (debug)"
      />
      <button onClick={submit}>Search</button>
    </div>
  );
}
