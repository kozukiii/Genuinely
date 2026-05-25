import { useEffect, useState } from "react";
import { fetchItemGroup, type EbayVariant, type EbayItemGroup } from "../utils/ebayApi";
import "./styles/VariantSelector.css";

type VariantSelectorProps = {
  itemGroupId: string;
  onVariantChange: (variant: EbayVariant | null) => void;
  onGroupLoaded?: (pricesVary: boolean) => void;
};

function variantMatchesSelection(
  variant: EbayVariant,
  selected: Record<string, string>
): boolean {
  return Object.entries(selected).every(
    ([key, value]) => variant.aspects[key] === value
  );
}

function isOptionReachable(
  group: EbayItemGroup,
  key: string,
  value: string,
  currentSelected: Record<string, string>
): boolean {
  // An option is reachable if at least one in-stock variant matches it
  // given the current selections for all OTHER keys.
  const partialWithThis = { ...currentSelected, [key]: value };
  return group.variants.some(
    (v) =>
      v.availability !== "OUT_OF_STOCK" &&
      variantMatchesSelection(v, partialWithThis)
  );
}

export default function VariantSelector({ itemGroupId, onVariantChange, onGroupLoaded }: VariantSelectorProps) {
  const [group, setGroup] = useState<EbayItemGroup | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedAspects, setSelectedAspects] = useState<Record<string, string>>({});
  const [noMatch, setNoMatch] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setGroup(null);
    setSelectedAspects({});
    setNoMatch(false);
    onVariantChange(null);

    fetchItemGroup(itemGroupId)
      .then((data) => {
        if (cancelled) return;
        setGroup(data);
        if (onGroupLoaded) {
          const uniquePrices = new Set(data.variants.map((v) => v.price));
          onGroupLoaded(uniquePrices.size > 1);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("VariantSelector: failed to load item group", err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  // itemGroupId is the only stable identity for this effect
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemGroupId]);

  // Resolve the active variant whenever selections change.
  // Only require the user to have selected every key that has >1 option —
  // single-value keys are never shown as dropdowns so they'll never be in
  // selectedAspects, and variantMatchesSelection only checks keys that ARE
  // in selectedAspects so the match still works correctly.
  useEffect(() => {
    if (!group) return;

    const selectableKeys = Object.keys(group.optionMatrix).filter(
      (k) => group.optionMatrix[k].length > 1
    );
    const allSelected = selectableKeys.every((k) => selectedAspects[k] != null);

    if (!allSelected) {
      setNoMatch(false);
      onVariantChange(null);
      return;
    }

    const match = group.variants.find((v) => variantMatchesSelection(v, selectedAspects));
    if (match) {
      setNoMatch(false);
      onVariantChange(match);
    } else {
      setNoMatch(true);
      onVariantChange(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAspects, group]);

  function handleSelect(key: string, value: string) {
    setSelectedAspects((prev) => ({ ...prev, [key]: value }));
  }

  if (loading) {
    return (
      <div className="variant-selector variant-selector--loading">
        <span className="variant-selector__loading-text">Loading options…</span>
      </div>
    );
  }

  const selectableEntries = Object.entries(group?.optionMatrix ?? {}).filter(([, v]) => v.length > 1);
  if (!group || selectableEntries.length === 0) {
    return null;
  }

  return (
    <div className="variant-selector">
      {Object.entries(group.optionMatrix).filter(([, values]) => values.length > 1).map(([key, values]) => (
        <div key={key} className="variant-selector__row">
          <label className="variant-selector__label" htmlFor={`vs-${key}`}>
            {key}
          </label>
          <select
            id={`vs-${key}`}
            className="variant-selector__select"
            value={selectedAspects[key] ?? ""}
            onChange={(e) => handleSelect(key, e.target.value)}
          >
            <option value="" disabled>Select {key}</option>
            {values.map((value) => {
              const reachable = isOptionReachable(group, key, value, selectedAspects);
              return (
                <option key={value} value={value} disabled={!reachable}>
                  {value}{!reachable ? " (unavailable)" : ""}
                </option>
              );
            })}
          </select>
        </div>
      ))}
      {noMatch && (
        <p className="variant-selector__no-match">
          Exact combination unavailable
        </p>
      )}
    </div>
  );
}
