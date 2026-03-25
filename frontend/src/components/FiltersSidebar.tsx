export interface FilterState {
  minPrice: string;
  maxPrice: string;
  condition: string;
  sources: { ebay: boolean; marketplace: boolean };
  freeShippingOnly: boolean;
  sortBy: string;
}

interface Props {
  filters: FilterState;
  onChange: (next: FilterState) => void;
}

export default function FiltersSidebar({ filters, onChange }: Props) {
  function set<K extends keyof FilterState>(key: K, value: FilterState[K]) {
    onChange({ ...filters, [key]: value });
  }

  function setSource(key: "ebay" | "marketplace", value: boolean) {
    onChange({ ...filters, sources: { ...filters.sources, [key]: value } });
  }

  return (
    <aside className="filters-sidebar">
      <h2 className="filters-title">Filters</h2>

      {/* Sort */}
      <div className="filter-group">
        <label className="filter-label">Sort by</label>
        <select
          className="filter-select"
          value={filters.sortBy}
          onChange={(e) => set("sortBy", e.target.value)}
        >
          <option value="default">Best Match</option>
          <option value="price_asc">Price: Low → High</option>
          <option value="price_desc">Price: High → Low</option>
          <option value="ai_score">AI Score</option>
        </select>
      </div>

      {/* Price range */}
      <div className="filter-group">
        <label className="filter-label">Price range</label>
        <div className="filter-price-row">
          <input
            className="filter-input"
            type="number"
            placeholder="Min"
            min={0}
            value={filters.minPrice}
            onChange={(e) => set("minPrice", e.target.value)}
          />
          <span className="filter-price-sep">–</span>
          <input
            className="filter-input"
            type="number"
            placeholder="Max"
            min={0}
            value={filters.maxPrice}
            onChange={(e) => set("maxPrice", e.target.value)}
          />
        </div>
      </div>

      {/* Condition */}
      <div className="filter-group">
        <label className="filter-label">Condition</label>
        <select
          className="filter-select"
          value={filters.condition}
          onChange={(e) => set("condition", e.target.value)}
        >
          <option value="any">Any</option>
          <option value="new">New</option>
          <option value="used">Used</option>
        </select>
      </div>

      {/* Sources */}
      <div className="filter-group">
        <label className="filter-label">Sources</label>
        <label className="filter-check">
          <input
            type="checkbox"
            checked={filters.sources.ebay}
            onChange={(e) => setSource("ebay", e.target.checked)}
          />
          eBay
        </label>
        <label className="filter-check">
          <input
            type="checkbox"
            checked={filters.sources.marketplace}
            onChange={(e) => setSource("marketplace", e.target.checked)}
          />
          Marketplace
        </label>
      </div>

      {/* Free shipping */}
      <div className="filter-group">
        <label className="filter-check">
          <input
            type="checkbox"
            checked={filters.freeShippingOnly}
            onChange={(e) => set("freeShippingOnly", e.target.checked)}
          />
          Free shipping only
        </label>
      </div>

      <button
        className="filter-reset"
        onClick={() =>
          onChange({
            minPrice: "",
            maxPrice: "",
            condition: "any",
            sources: { ebay: true, marketplace: true },
            freeShippingOnly: false,
            sortBy: "default",
          })
        }
      >
        Reset filters
      </button>
    </aside>
  );
}
