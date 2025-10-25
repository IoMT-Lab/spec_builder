import { useState, useEffect } from 'react';

/* Draftsman-style SVG background for schematic line art */
export default function DraftsmanBackground() {
  const [frameRect, setFrameRect] = useState({ x: 0, y: 0, width: 0, height: 0 });

  useEffect(() => {
    const updateFrameRect = () => {
      // Find the app-main-block element (the main content container)
      const mainBlock = document.querySelector('.app-main-block');
      if (mainBlock) {
        const rect = mainBlock.getBoundingClientRect();
        setFrameRect({
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        });
      }
    };

    updateFrameRect();
    window.addEventListener('resize', updateFrameRect);
    // Also update on a small delay to catch layout shifts
    const timer = setTimeout(updateFrameRect, 100);

    return () => {
      window.removeEventListener('resize', updateFrameRect);
      clearTimeout(timer);
    };
  }, []);

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
      viewBox={`0 0 ${window.innerWidth} ${window.innerHeight}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Soft aurora block framing the interface */}
      <rect
        x={frameRect.x}
        y={frameRect.y}
        width={frameRect.width}
        height={frameRect.height}
        rx="28"
        fill="url(#aurora-frame)"
        opacity="0.82"
      />
      {/* Diagonal and technical lines */}
      <line x1="0" y1={window.innerHeight * 0.83} x2={window.innerWidth} y2={window.innerHeight * 0.39} stroke="rgba(148,163,184,0.22)" strokeWidth="1.5" opacity="0.35"/>
      <line x1={window.innerWidth * 0.22} y1="0" x2={window.innerWidth * 0.22} y2={window.innerHeight} stroke="rgba(148,163,184,0.18)" strokeWidth="1" opacity="0.25"/>
      <line x1="0" y1={window.innerHeight * 0.3} x2={window.innerWidth} y2={window.innerHeight * 0.3} stroke="rgba(148,163,184,0.18)" strokeWidth="1" opacity="0.25"/>

      <defs>
        <linearGradient id="aurora-frame" x1={frameRect.x} y1={frameRect.y} x2={frameRect.x + frameRect.width} y2={frameRect.y + frameRect.height} gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="rgba(56, 189, 248, 0.16)"/>
          <stop offset="45%" stopColor="rgba(129, 140, 248, 0.22)"/>
          <stop offset="100%" stopColor="rgba(168, 85, 247, 0.18)"/>
        </linearGradient>
      </defs>
    </svg>
  );
}
