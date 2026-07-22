/** The AgentStack mark: three stacked tiles, the front one carrying the diamond. */
export function AgentstackMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 120 120"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id="agentstack-mark-g"
          x1="18"
          x2="84"
          y1="34"
          y2="100"
        >
          <stop offset="0" stopColor="#F0975A" />
          <stop offset="1" stopColor="#C96F2F" />
        </linearGradient>
      </defs>
      <rect
        fill="none"
        height="66"
        opacity="0.25"
        rx="17"
        stroke="currentColor"
        strokeWidth="7"
        width="66"
        x="44"
        y="8"
      />
      <rect
        fill="none"
        height="66"
        opacity="0.5"
        rx="17"
        stroke="currentColor"
        strokeWidth="7"
        width="66"
        x="31"
        y="21"
      />
      <rect fill="url(#agentstack-mark-g)" height="66" rx="17" width="66" x="18" y="34" />
      <path d="M51 57 L61 67 L51 77 L41 67 Z" fill="#FDF6EE" />
    </svg>
  );
}
