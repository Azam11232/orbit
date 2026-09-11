type OrbitBrandProps = {
  className?: string;
  compact?: boolean;
  variant?: "light" | "dark";
};

export function OrbitBrand({ className = "", compact = false, variant = "light" }: OrbitBrandProps) {
  const stroke = variant === "dark" ? "#020817" : "#F8FAFC";
  const accent = variant === "dark" ? "#0F172A" : "#E2E8F0";

  if (compact) {
    return (
      <svg
        viewBox="0 0 64 64"
        aria-label="ORBIT"
        className={className}
        role="img"
        xmlns="http://www.w3.org/2000/svg"
      >
        <g fill="none" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="32" cy="32" r="20" stroke={stroke} strokeWidth="2.2" opacity="0.92" />
          <path d="M15 42c5.7 8.7 17.2 12.3 27.4 7.3 8.1-3.9 12.6-12.5 12.6-21.3" stroke={stroke} strokeWidth="2.2" opacity="0.96" />
          <path d="M49 22C43.3 13.3 31.8 9.7 21.6 14.7 13.5 18.6 9 27.2 9 36" stroke={stroke} strokeWidth="2.2" opacity="0.8" />
          <circle cx="49" cy="22" r="3.7" fill={stroke} />
          <circle cx="15" cy="42" r="3.7" fill={accent} stroke={stroke} strokeWidth="1.2" />
        </g>
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 320 88"
      aria-label="ORBIT"
      className={className}
      role="img"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        <g transform="translate(6 8)">
          <circle cx="32" cy="32" r="22" stroke={stroke} strokeWidth="2.4" opacity="0.95" />
          <path d="M12 43c7.1 10.6 20.9 14.5 31.6 9.2C58.4 47.3 63.6 35.2 63.6 23.2" stroke={stroke} strokeWidth="2.4" opacity="0.96" />
          <path d="M52 21C45.5 11.2 32.1 6.5 20.9 11.6 11.3 15.9 6 24.9 6 34.3" stroke={stroke} strokeWidth="2.4" opacity="0.82" />
          <circle cx="52" cy="21" r="4.2" fill={stroke} />
          <circle cx="12" cy="43" r="4.2" fill={accent} stroke={stroke} strokeWidth="1.2" />
        </g>
        <text
          x="92"
          y="49"
          fill={stroke}
          fontSize="32"
          fontWeight="800"
          letterSpacing="8"
          fontFamily="Inter, Segoe UI, sans-serif"
        >
          ORBIT
        </text>
      </g>
    </svg>
  );
}
