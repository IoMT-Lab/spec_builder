/* Draftsman-style SVG background for schematic line art */
export default function DraftsmanBackground() {
  return (
    <svg
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        zIndex: 0,
        pointerEvents: 'none',
        opacity: 0.7,
      }}
      /* width/height attributes removed to satisfy React/SVG expectations */
      viewBox="0 0 1920 1080"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Soft aurora block framing the interface */}
      <rect
        x="320"
        y="120"
        width="1280"
        height="640"
        rx="28"
        fill="url(#aurora-frame)"
        opacity="0.82"
      />
      {/* Diagonal and technical lines */}
      <line x1="0" y1="900" x2="1920" y2="420" stroke="rgba(148,163,184,0.22)" strokeWidth="1.5" opacity="0.35"/>
      <line x1="420" y1="0" x2="420" y2="1080" stroke="rgba(148,163,184,0.18)" strokeWidth="1" opacity="0.25"/>
      <line x1="0" y1="320" x2="1920" y2="320" stroke="rgba(148,163,184,0.18)" strokeWidth="1" opacity="0.25"/>

      <defs>
        <linearGradient id="aurora-frame" x1="320" y1="120" x2="1600" y2="760" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="rgba(56, 189, 248, 0.16)"/>
          <stop offset="45%" stopColor="rgba(129, 140, 248, 0.22)"/>
          <stop offset="100%" stopColor="rgba(168, 85, 247, 0.18)"/>
        </linearGradient>
      </defs>
    </svg>
  );
}
