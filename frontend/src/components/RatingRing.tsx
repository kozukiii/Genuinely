interface RatingRingProps {
  value: number;   // 0–100
  size?: number;   // optional size (default 48)
}

export default function RatingRing({ value, size = 48 }: RatingRingProps) {
  const center = size / 2;
  const radius = size * 0.37;            // scales with size
  const strokeWidth = size * 0.10;       // scales with size
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (value / 100) * circumference;

  const color =
    value >= 67 ? "#22c55e" :
    value >= 33 ? "#facc15" :
                  "#ef4444";

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="rating-ring"
    >
      <circle
        cx={center}
        cy={center}
        r={radius}
        stroke="#374151"
        strokeWidth={strokeWidth}
        fill="none"
      />

      <circle
        cx={center}
        cy={center}
        r={radius}
        stroke={color}
        strokeWidth={strokeWidth}
        fill="none"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${center} ${center})`}
      />

      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
        fill="#e5e7eb"
        fontSize={size * 0.28}
        fontWeight="600"
      >
        {Math.round(value)}
      </text>
    </svg>
  );
}
