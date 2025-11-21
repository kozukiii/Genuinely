interface RatingRingProps {
  value: number; // 0 to 100
}

export default function RatingRing({ value }: RatingRingProps) {
  const radius = 18;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (value / 100) * circumference;

  // Determine color based on value
  const color =
    value >= 67 ? "#22c55e" : value >= 33 ? "#facc15" : "#ef4444"; // green / yellow / red

  return (
    <svg
      width="48"
      height="48"
      viewBox="0 0 48 48"
      className="rating-ring"
    >
      <circle
        cx="24"
        cy="24"
        r={radius}
        stroke="#374151" /* gray background ring */
        strokeWidth="5"
        fill="none"
      />
      <circle
        cx="24"
        cy="24"
        r={radius}
        stroke={color}
        strokeWidth="5"
        fill="none"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform="rotate(-90 24 24)" /* start at top */
      />
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
        fill="#e5e7eb"
        fontSize="12"
        fontWeight="600"
      >
        {Math.round(value)}
      </text>
    </svg>
  );
}
