import { useEffect, useState } from "react";

export interface FilterState {
  minPrice: string;
  maxPrice: string;
  condition: string;
  sources: { ebay: boolean; marketplace: boolean };
  freeShippingOnly: boolean;
  sortBy: string;
  limit: string;
  zip: string;
  marketplaceRadius: string;
}

const DEFAULT_FILTERS: FilterState = {
  minPrice: "",
  maxPrice: "",
  condition: "any",
  sources: { ebay: true, marketplace: true },
  freeShippingOnly: false,
  sortBy: "ai_score",
  limit: "",
  zip: "",
  marketplaceRadius: "",
};

interface Props {
  filters: FilterState;
  onChange: (next: FilterState) => void;
  onSortChange: (sortBy: string) => void;
  onDraftChange?: (draft: FilterState) => void;
  mobileOpen?: boolean;
}

export default function FiltersSidebar({ filters, onChange, onSortChange, onDraftChange, mobileOpen = false }: Props) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("filters:collapsed") === "1");
  const [draft, setDraft] = useState<FilterState>(filters);

  useEffect(() => { setDraft(filters); }, [filters]);
  useEffect(() => { onDraftChange?.(draft); }, [draft, onDraftChange]);

  function setDraftField<K extends keyof FilterState>(key: K, value: FilterState[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function setDraftSource(key: "ebay" | "marketplace", value: boolean) {
    setDraft((prev) => ({ ...prev, sources: { ...prev.sources, [key]: value } }));
  }

  return (
    <aside className={`filters-sidebar${collapsed ? " collapsed" : ""}${mobileOpen ? " mobile-open" : ""}`}>
      <button
        className="sidebar-toggle"
        onClick={() => setCollapsed((c) => { const next = !c; localStorage.setItem("filters:collapsed", next ? "1" : "0"); return next; })}
        title={collapsed ? "Show filters" : "Hide filters"}
      >
        {collapsed ? "Filters" : "◀"}
      </button>

      {!collapsed && (
        <div className="sidebar-inner">
          <h2 className="filters-title">Filters</h2>

          <div className="filter-group">
            <label className="filter-label">Sort by</label>
            <select className="filter-select" value={filters.sortBy} onChange={(e) => onSortChange(e.target.value)}>
              <option value="default">Best Match</option>
              <option value="price_asc">Price: Low → High</option>
              <option value="price_desc">Price: High → Low</option>
              <option value="ai_score">AI Score</option>
            </select>
          </div>

          <div className="filter-group">
            <label className="filter-label">Price range</label>
            <div className="filter-price-row">
              <input className="filter-input" type="number" placeholder="Min" min={0} value={draft.minPrice}
                onChange={(e) => setDraftField("minPrice", e.target.value)} />
              <span className="filter-price-sep">–</span>
              <input className="filter-input" type="number" placeholder="Max" min={0} value={draft.maxPrice}
                onChange={(e) => setDraftField("maxPrice", e.target.value)} />
            </div>
          </div>

          <div className="filter-group">
            <label className="filter-label">Sources</label>
            <label className="filter-check">
              <input type="checkbox" checked={draft.sources.ebay} onChange={(e) => setDraftSource("ebay", e.target.checked)} /> eBay
            </label>
            <label className="filter-check">
              <input type="checkbox" checked={draft.sources.marketplace} onChange={(e) => setDraftSource("marketplace", e.target.checked)} /> Marketplace
            </label>
          </div>

          <div className="filter-group">
            <label className="filter-check">
              <input type="checkbox" checked={draft.freeShippingOnly} onChange={(e) => setDraftField("freeShippingOnly", e.target.checked)} /> Free shipping only
            </label>
          </div>

          <div className="filter-group">
            <label className="filter-label">Zip code</label>
            <input className="filter-input" type="text" inputMode="numeric" maxLength={10} placeholder="Auto-detected"
              value={draft.zip} onChange={(e) => setDraftField("zip", e.target.value.replace(/[^0-9]/g, ""))} />
          </div>

          {draft.sources.marketplace && (
            <div className="filter-group filter-group--marketplace">
              <label className="filter-label">Marketplace radius</label>
              <select className="filter-select" value={draft.marketplaceRadius} onChange={(e) => setDraftField("marketplaceRadius", e.target.value)}>
                <option value="">Default (10 mi)</option>
                <option value="10">10 mi</option>
                <option value="20">20 mi</option>
                <option value="40">40 mi</option>
                <option value="60">60 mi</option>
                <option value="100">100 mi</option>
              </select>
            </div>
          )}

          <div className="filter-group">
            <label className="filter-label">Max results</label>
            <input className="filter-input" type="number" placeholder="Default" min={1}
              value={draft.limit} onChange={(e) => setDraftField("limit", e.target.value)} />
          </div>

          <button className="filter-apply" onClick={() => onChange(draft)}>Update Results</button>
          <button className="filter-reset" onClick={() => { setDraft(DEFAULT_FILTERS); onChange(DEFAULT_FILTERS); }}>Reset</button>
        </div>
      )}
    </aside>
  );
}
