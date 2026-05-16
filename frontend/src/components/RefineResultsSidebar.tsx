export interface HighlightBadge {
  label: string;
  positive: boolean;
  count: number;
}

interface Props {
  badges: HighlightBadge[];
  open: boolean;
  onToggle: () => void;
}

export default function RefineResultsSidebar({ badges, open, onToggle }: Props) {
  if (badges.length === 0 || open) return null;

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
