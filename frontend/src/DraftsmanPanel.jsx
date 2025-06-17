import React from 'react';
import './App.css';

export default function DraftsmanPanel({ label, expand, children, style = {}, className = '' }) {
  return (
    <div className="draftsman-panel-outer">
      <div className="draftsman-panel-label-row">
        <div className="draftsman-panel-label-svgstyle">{label}</div>
        {expand && <span className="panel-expand">{expand}</span>}
      </div>
      <div className={`draftsman-panel ${className}`} style={style}>
        {children}
      </div>
    </div>
  );
}
