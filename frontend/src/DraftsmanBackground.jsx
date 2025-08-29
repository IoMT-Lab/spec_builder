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
      {/* Main neon block */}
      <rect x="200" y="100" width="1400" height="600" fill="#B6FF00" opacity="0.85"/>
      {/* Diagonal and technical lines */}
      <line x1="0" y1="900" x2="1920" y2="400" stroke="#181818" strokeWidth="1.5" opacity="0.3"/>
      <line x1="400" y1="0" x2="400" y2="1080" stroke="#181818" strokeWidth="1" opacity="0.2"/>
      <line x1="0" y1="300" x2="1920" y2="300" stroke="#181818" strokeWidth="1" opacity="0.2"/>
    </svg>
  );
}
