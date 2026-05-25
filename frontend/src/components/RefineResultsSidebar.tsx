export interface HighlightBadge {
  label: string;
  positive: boolean;
  count: number;
}

interface Props {
  badges: HighlightBadge[];
  hasPriceBadges?: boolean;
  open: boolean;
  onToggle: () => void;
}

export default function RefineResultsSidebar({ badges, hasPriceBadges = false, open, onToggle }: Props) {
  if ((badges.length === 0 && !hasPriceBadges) || open) return null;

  return (
    <aside className="refine-sidebar">
      <button
        className="refine-toggle"
        onClick={onToggle}
        title="Show refine options"
      >
        Refine
      </button>
    </aside>
  );
}
