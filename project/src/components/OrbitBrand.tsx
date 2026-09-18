type OrbitBrandProps = {
  className?: string;
  compact?: boolean;
  variant?: "light" | "dark";
};

export function OrbitBrand({
  className = "",
  compact = false,
  variant = "light",
}: OrbitBrandProps) {
  const textColor = variant === "dark" ? "#020817" : "#F8FAFC";

  if (compact) {
    return (
      <svg
        viewBox="0 0 64 64"
        aria-label="ORBIT"
        className={className}
        role="img"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient
            id="orbitCompactGradient"
            x1="8"
            y1="8"
            x2="56"
            y2="56"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="#8B5CF6" />
            <stop offset="0.5" stopColor="#6366F1" />
            <stop offset="1" stopColor="#22D3EE" />
          </linearGradient>
        </defs>

        <g
          fill="none"
          stroke="url(#orbitCompactGradient)"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle
            cx="32"
            cy="32"
            r="20"
            strokeWidth="3"
            opacity="0.95"
          />

          <path
            d="M15 42c5.7 8.7 17.2 12.3 27.4 7.3 8.1-3.9 12.6-12.5 12.6-21.3"
            strokeWidth="3"
          />

          <path
            d="M49 22C43.3 13.3 31.8 9.7 21.6 14.7 13.5 18.6 9 27.2 9 36"
            strokeWidth="3"
            opacity="0.85"
          />

          <circle
            cx="49"
            cy="22"
            r="4"
            fill="url(#orbitCompactGradient)"
            stroke="none"
          />

          <circle
            cx="15"
            cy="42"
            r="4"
            fill="#22D3EE"
            stroke="none"
          />
        </g>
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 8 320 56"
      aria-label="ORBIT"
      className={className}
      role="img"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id="orbitBrandGradient"
          x1="6"
          y1="8"
          x2="70"
          y2="72"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#A855F7" />
          <stop offset="0.42" stopColor="#8B5CF6" />
          <stop offset="0.72" stopColor="#6366F1" />
          <stop offset="1" stopColor="#22D3EE" />
        </linearGradient>
      </defs>

      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        <g transform="translate(6 8)">
          <circle
            cx="32"
            cy="32"
            r="22"
            stroke="url(#orbitBrandGradient)"
            strokeWidth="3"
            opacity="0.96"
          />

          <path
            d="M12 43c7.1 10.6 20.9 14.5 31.6 9.2C58.4 47.3 63.6 35.2 63.6 23.2"
            stroke="url(#orbitBrandGradient)"
            strokeWidth="3"
          />

          <path
            d="M52 21C45.5 11.2 32.1 6.5 20.9 11.6 11.3 15.9 6 24.9 6 34.3"
            stroke="url(#orbitBrandGradient)"
            strokeWidth="3"
            opacity="0.82"
          />

          <circle
            cx="52"
            cy="21"
            r="4.5"
            fill="#A855F7"
            stroke="none"
          />

          <circle
            cx="12"
            cy="43"
            r="4.5"
            fill="#22D3EE"
            stroke="none"
          />
        </g>

        <text
          x="92"
          y="49"
          fill={textColor}
          fontSize="32"
          fontWeight="800"
          letterSpacing="8"
          textLength="176"
          lengthAdjust="spacingAndGlyphs"
          fontFamily="Inter, Segoe UI, sans-serif"
        >
          ORBIT
        </text>
      </g>
    </svg>
  );
}