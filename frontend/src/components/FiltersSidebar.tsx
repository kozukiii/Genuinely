import { useEffect, useState } from "react";

export interface FilterState {
  minPrice: string;
  maxPrice: string;
  condition: string;
  sources: { ebay: boolean; marketplace: boolean };
  freeShippingOnly: boolean;
  sortBy: string;
}

const DEFAULT_FILTERS: FilterState = {
  minPrice: "",
  maxPrice: "",
  condition: "any",
  sources: { ebay: true, marketplace: true },
  freeShippingOnly: false,
  sortBy: "default",
};

interface Props {
  filters: FilterState;
  onChange: (next: FilterState) => void;
}

export default function FiltersSidebar({ filters, onChange }: Props) {
  const [collapsed, setCollapsed] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 768
  );
  const [draft, setDraft] = useState<FilterState>(filters);

  // Keep draft in sync if parent resets filters externally
  useEffect(() => {
    setDraft(filters);
  }, [filters]);

  function setDraftField<K extends keyof FilterState>(key: K, value: FilterState[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function setDraftSource(key: "ebay" | "marketplace", value: boolean) {
    setDraft((prev) => ({ ...prev, sources: { ...prev.sources, [key]: value } }));
  }

  function handleApply() {
    onChange(draft);
  }

  function handleReset() {
    setDraft(DEFAULT_FILTERS);
    onChange(DEFAULT_FILTERS);
  }

  return (
    <aside className={`filters-sidebar${collapsed ? " collapsed" : ""}`}>
      <button
        className="sidebar-toggle"
        onClick={() => setCollapsed((c) => !c)}
        title={collapsed ? "Show filters" : "Hide filters"}
      >
        {collapsed ? "Filters" : "◀"}
      </button>

      {!collapsed && (
        <div className="sidebar-inner">
          <h2 className="filters-title">Filters</h2>

          {/* Sort */}
          <div className="filter-group">
            <label className="filter-label">Sort by</label>
            <select
              className="filter-select"
              value={draft.sortBy}
              onChange={(e) => setDraftField("sortBy", e.target.value)}
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
                value={draft.minPrice}
                onChange={(e) => setDraftField("minPrice", e.target.value)}
              />
              <span className="filter-price-sep">–</span>
              <input
                className="filter-input"
                type="number"
                placeholder="Max"
                min={0}
                value={draft.maxPrice}
                onChange={(e) => setDraftField("maxPrice", e.target.value)}
              />
            </div>
          </div>

          {/* Condition */}
          <div className="filter-group">
            <label className="filter-label">Condition</label>
            <select
              className="filter-select"
              value={draft.condition}
              onChange={(e) => setDraftField("condition", e.target.value)}
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
                checked={draft.sources.ebay}
                onChange={(e) => setDraftSource("ebay", e.target.checked)}
              />
              eBay
            </label>
            <label className="filter-check">
              <input
                type="checkbox"
                checked={draft.sources.marketplace}
                onChange={(e) => setDraftSource("marketplace", e.target.checked)}
              />
              Marketplace
            </label>
          </div>

          {/* Free shipping */}
          <div className="filter-group">
            <label className="filter-check">
              <input
                type="checkbox"
                checked={draft.freeShippingOnly}
                onChange={(e) => setDraftField("freeShippingOnly", e.target.checked)}
              />
              Free shipping only
            </label>
          </div>

          <button className="filter-apply" onClick={handleApply}>
            Apply Filters
          </button>

          <button className="filter-reset" onClick={handleReset}>
            Reset
          </button>
        </div>
      )}
    </aside>
  );
}
