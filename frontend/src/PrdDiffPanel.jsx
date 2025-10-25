import React, { useEffect, useMemo, useState } from 'react';
import { diffLines, structuredPatch } from 'diff';
import './App.css';

// Split text into lines (always produce an array)
function splitLines(text) {
  if (typeof text !== 'string') return [];
  return text.split(/\r?\n/);
}

// Compute a unified, per-line diff with positional metadata
// Returns [{ type: 'added'|'removed'|'unchanged', value, oldLine, newLine, oldPos, newPos }]
function computeUnifiedDiff(oldLines, newLines) {
  const parts = diffLines(oldLines.join('\n'), newLines.join('\n'));
  const result = [];
  let oldPos = 0;
  let newPos = 0;
  parts.forEach(part => {
    const lines = part.value.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (i === lines.length - 1 && line === '') continue; // skip trailing empty
      if (part.added) {
        result.push({ type: 'added', value: line, oldLine: null, newLine: newPos + 1, oldPos, newPos });
        newPos++;
      } else if (part.removed) {
        result.push({ type: 'removed', value: line, oldLine: oldPos + 1, newLine: null, oldPos, newPos });
        oldPos++;
      } else {
        result.push({ type: 'unchanged', value: line, oldLine: oldPos + 1, newLine: newPos + 1, oldPos, newPos });
        oldPos++;
        newPos++;
      }
    }
  });
  return result;
}

const PrdDiffPanel = ({ sessionId, refreshKey, onSave, onDiffStateChange }) => {
  // Left (working) and right (proposal) texts as arrays of lines
  const [leftLines, setLeftLines] = useState([]);
  const [rightLines, setRightLines] = useState([]);
  const [diff, setDiff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState([]); // stack of { left, right }
  const [viewMode, setViewMode] = useState('split'); // 'split' | 'unified'
  const [hasTemp, setHasTemp] = useState(false);

  // Load initial pair (main PRD vs temp draft)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const ts = Date.now();
    fetch(`/api/sessions/${sessionId}/prd/diff?ts=${ts}`, { cache: 'no-store' })
      .then(r => {
        if (!r.ok) throw new Error('Failed to load diff');
        return r.json();
      })
      .then(data => {
        if (cancelled) return;
        const left = splitLines(data.oldText || '');
        const right = splitLines(data.newText || '');
        setHasTemp(Boolean(data.hasTemp));
        setLeftLines(left);
        setRightLines(right);
        setHistory([]);
        setLoading(false);
        try {
          // eslint-disable-next-line no-console
          console.info(`[PRD DEBUG] Diff fetch: hasTemp=${Boolean(data.hasTemp)} leftLines=${left.length} rightLines=${right.length}`);
        } catch {}
        if (typeof onDiffStateChange === 'function') onDiffStateChange(Boolean(data.hasTemp));
      })
      .catch(e => {
        if (cancelled) return;
        console.error('DIFF FETCH ERROR:', e);
        setLeftLines([]);
        setRightLines([]);
        setDiff([]);
        setHistory([]);
        setError('No PRD changes to review yet.');
        setLoading(false);
        if (typeof onDiffStateChange === 'function') onDiffStateChange(false);
      });
    return () => { cancelled = true; };
  }, [sessionId, refreshKey]);

  // Recompute diff whenever left/right change (only when a temp proposal exists)
  useEffect(() => {
    if (!hasTemp) { setDiff([]); return; }
    const next = computeUnifiedDiff(leftLines, rightLines);
    setDiff(next);
    try {
      const changes = next.filter(d => d.type !== 'unchanged').length;
      // eslint-disable-next-line no-console
      console.info(`[PRD DEBUG] Diff recomputed: hasTemp=${hasTemp} changes=${changes} (left=${leftLines.length}, right=${rightLines.length})`);
    } catch {}
  }, [leftLines, rightLines, hasTemp]);

  const canUndo = history.length > 0;
  const hasChanges = useMemo(() => diff.some(d => d.type !== 'unchanged'), [diff]);

  // Compute structured patch hunks for split view (with N context lines)
  const hunks = useMemo(() => {
    const oldStr = leftLines.join('\n');
    const newStr = rightLines.join('\n');
    const patch = structuredPatch('old', 'new', oldStr, newStr, '', '', { context: 3 });
    return patch.hunks || [];
  }, [leftLines, rightLines]);

  // Helpers to push snapshot and restore
  const pushSnapshot = () => {
    setHistory(h => [...h, { left: leftLines.slice(), right: rightLines.slice() }]);
  };

  const handleUndo = () => {
    setHistory(h => {
      if (h.length === 0) return h;
      const next = h.slice(0, -1);
      const last = h[h.length - 1];
      setLeftLines(last.left.slice());
      setRightLines(last.right.slice());
      return next;
    });
  };

  // Apply actions to shrink the diff and re-diff
  const handleAccept = (idx) => {
    const d = diff[idx];
    if (!d || d.type === 'unchanged') return;
    pushSnapshot();
    try { console.debug('[PRD DEBUG] Accept line change at index', idx, d.type); } catch {}
    if (d.type === 'added') {
      // Bring the proposed line into the working doc (insert into left at oldPos)
      setLeftLines(prev => {
        const next = prev.slice();
        const pos = Math.max(0, Math.min(d.oldPos, next.length));
        next.splice(pos, 0, d.value);
        return next;
      });
    } else if (d.type === 'removed') {
      // Accept the removal: delete from left at oldPos
      setLeftLines(prev => {
        const next = prev.slice();
        if (d.oldPos >= 0 && d.oldPos < next.length) next.splice(d.oldPos, 1);
        return next;
      });
    }
  };

  const handleReject = (idx) => {
    const d = diff[idx];
    if (!d || d.type === 'unchanged') return;
    pushSnapshot();
    try { console.debug('[PRD DEBUG] Reject line change at index', idx, d.type); } catch {}
    if (d.type === 'added') {
      // Reject the addition: remove from right at newPos
      setRightLines(prev => {
        const next = prev.slice();
        if (d.newPos >= 0 && d.newPos < next.length) next.splice(d.newPos, 1);
        return next;
      });
    } else if (d.type === 'removed') {
      // Reject the removal: reinsert into right at newPos
      setRightLines(prev => {
        const next = prev.slice();
        const pos = Math.max(0, Math.min(d.newPos, next.length));
        next.splice(pos, 0, d.value);
        return next;
      });
    }
  };

  // Build array of lines for new/old blocks from a hunk
  const getHunkNewBlock = (hunk) => hunk.lines
    .filter(l => l[0] === ' ' || l[0] === '+')
    .map(l => l.slice(1));
  const getHunkOldBlock = (hunk) => hunk.lines
    .filter(l => l[0] === ' ' || l[0] === '-')
    .map(l => l.slice(1));

  // Accept entire hunk: replace left slice with the hunk's new block
  const handleAcceptHunk = (hunkIdx) => {
    const h = hunks[hunkIdx];
    if (!h) return;
    pushSnapshot();
    try { console.debug('[PRD DEBUG] Accept hunk', hunkIdx, `oldStart=${h.oldStart}, newStart=${h.newStart}`); } catch {}
    const insert = getHunkNewBlock(h);
    const start = Math.max(0, (h.oldStart || 1) - 1);
    const del = Math.max(0, h.oldLines || 0);
    setLeftLines(prev => {
      const next = prev.slice();
      next.splice(start, del, ...insert);
      return next;
    });
  };

  // Reject entire hunk: replace right slice with the hunk's old block
  const handleRejectHunk = (hunkIdx) => {
    const h = hunks[hunkIdx];
    if (!h) return;
    pushSnapshot();
    try { console.debug('[PRD DEBUG] Reject hunk', hunkIdx, `oldStart=${h.oldStart}, newStart=${h.newStart}`); } catch {}
    const insert = getHunkOldBlock(h);
    const start = Math.max(0, (h.newStart || 1) - 1);
    const del = Math.max(0, h.newLines || 0);
    setRightLines(prev => {
      const next = prev.slice();
      next.splice(start, del, ...insert);
      return next;
    });
  };

  // Accept/Reject all changes quickly
  const handleAcceptAll = () => {
    // Bring all proposed lines into the working doc, then immediately finalize
    // so the temp draft is removed and the UI returns to Markdown view.
    pushSnapshot();
    try { console.info('[PRD DEBUG] Accept ALL changes'); } catch {}
    const mergedText = rightLines.join('\n');
    setLeftLines(rightLines.slice());
    setSaving(true);
    fetch(`/api/sessions/${sessionId}/prd/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mergedText })
    })
      .then(r => r.json())
      .then(data => {
        setSaving(false);
        if (data.ok) {
          setHistory([]);
          if (typeof onDiffStateChange === 'function') onDiffStateChange(false);
          if (onSave) onSave();
          try { console.info('[PRD DEBUG] Accept ALL finalized; backend ok=true'); } catch {}
        }
      })
      .catch(e => { setError('Failed to save'); setSaving(false); });
  };
  const handleRejectAll = () => {
    // Discard the entire proposal: remove the temp draft on the server
    pushSnapshot();
    try { console.info('[PRD DEBUG] Reject ALL changes'); } catch {}
    setSaving(true);
    fetch(`/api/sessions/${sessionId}/prd/reject`, { method: 'POST' })
      .then(r => r.json())
      .then(data => {
        setSaving(false);
        setHistory([]);
        if (typeof onDiffStateChange === 'function') onDiffStateChange(false);
        if (onSave) onSave();
        try { console.info('[PRD DEBUG] Reject ALL completed; backend ok=true'); } catch {}
      })
      .catch(e => { setError('Failed to save'); setSaving(false); });
  };

  // Convert a hunk's lines into side-by-side rows
  const hunkRows = (h) => {
    const rows = [];
    for (let i = 0; i < h.lines.length; i++) {
      const line = h.lines[i];
      const tag = line[0];
      const text = line.slice(1);
      if (tag === ' ') {
        rows.push({ left: text, right: text, type: 'context' });
      } else if (tag === '-') {
        const nxt = h.lines[i + 1];
        if (nxt && nxt[0] === '+') {
          rows.push({ left: text, right: nxt.slice(1), type: 'modify' });
          i++;
        } else {
          rows.push({ left: text, right: '', type: 'remove' });
        }
      } else if (tag === '+') {
        rows.push({ left: '', right: text, type: 'add' });
      } else {
        // ignore '?' meta lines
      }
    }
    return rows;
  };

  // Save the merged working document (left)
  const handleSave = () => {
    setSaving(true);
    const mergedText = leftLines.join('\n');
    try { console.info('[PRD DEBUG] Finalize & Save PRD (mergedText length)', mergedText.length); } catch {}
    fetch(`/api/sessions/${sessionId}/prd/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mergedText })
    })
      .then(r => r.json())
      .then(data => {
        setSaving(false);
        if (data.ok) {
          setHistory([]);
          if (onSave) onSave();
          try { console.info('[PRD DEBUG] Merge saved; backend reported ok=true'); } catch {}
        }
      })
      .catch(e => { setError('Failed to save'); setSaving(false); });
  };

  if (loading) {
    return <div className="prd-diff-panel" style={{ padding: 32, fontSize: '0.95rem', color: 'var(--text-secondary)' }}>Loading PRD diff...</div>;
  }
  if (error) {
    return <div className="prd-diff-panel" style={{ padding: 32, color: '#fca5a5' }}>{error}</div>;
  }
  if (!hasTemp) {
    return null;
  }
  if (!hasChanges) {
    try {
      // eslint-disable-next-line no-console
      console.info(`[PRD DEBUG] No visible differences: hasTemp=${hasTemp}. Showing placeholder instead of blank panel.`);
    } catch {}
    return (
      <div className="prd-diff-panel">
        <div className="prd-diff-panel__header">
          <h2>Review PRD Changes</h2>
        </div>
        <div className="diff-empty-state">
          <p>No differences to review at the moment. This can happen briefly while the diff recomputes or after accepting all changes.</p>
          <div className="diff-empty-actions">
            <button className="diff-btn diff-btn--primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Finalize & Save PRD'}
            </button>
            <button className="diff-btn diff-btn--ghost" onClick={handleRejectAll}>Reject All</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="prd-diff-panel">
      <div className="section-title">Review PRD Changes</div>
      <div className="prd-diff-panel__header">
        <div className="prd-diff-panel__actions">
          <button className="diff-btn diff-btn--ghost" onClick={() => setViewMode(v => v === 'split' ? 'unified' : 'split')}>
            {viewMode === 'split' ? 'Switch to Unified' : 'Switch to Split'}
          </button>
          <button className="diff-btn diff-btn--primary" onClick={handleAcceptAll} title="Accept all proposed changes">Accept All</button>
          <button className="diff-btn diff-btn--danger" onClick={handleRejectAll} title="Reject all proposed changes">Reject All</button>
        </div>
      </div>

      <div className="prd-diff-content" key={rightLines.join('\n').substring(0, 50)}>
        {viewMode === 'split' ? (
        <div className="diff-split-view">
          {hunks.map((h, i) => (
            <div key={i} className="diff-hunk">
              <div className="diff-hunk__header">
                <div className="diff-hunk__meta">{`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`}</div>
                <div className="diff-hunk__actions">
                  <button className="diff-btn diff-btn--accept" onClick={() => handleAcceptHunk(i)}>Accept Hunk</button>
                  <button className="diff-btn diff-btn--reject" onClick={() => handleRejectHunk(i)}>Reject Hunk</button>
                </div>
              </div>
              <div className="diff-hunk__body">
                <div className="diff-hunk__col diff-hunk__col--left">
                  {hunkRows(h).map((r, idx) => (
                    <div key={idx} className={`diff-line diff-line--${r.type}`}>{r.left}</div>
                  ))}
                </div>
                <div className="diff-hunk__col diff-hunk__col--right">
                  {hunkRows(h).map((r, idx) => (
                    <div key={idx} className={`diff-line diff-line--${r.type}`}>{r.right}</div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="diff-unified-view">
          {diff.map((d, idx) => (
            <div key={idx} className={`diff-row diff-row--${d.type}`}>
              <span className="diff-row__prefix">{d.type === 'added' ? '+' : d.type === 'removed' ? '−' : ' '}</span>
              <span className="diff-row__line">{d.type === 'added' ? (d.newLine != null ? `+${d.newLine}` : '') : d.type === 'removed' ? (d.oldLine != null ? `−${d.oldLine}` : '') : (d.newLine ?? d.oldLine ?? '')}</span>
              <span className="diff-row__content">{d.value || ''}</span>
              {d.type !== 'unchanged' && (
                <span className="diff-row__actions">
                  <button className="diff-btn diff-btn--accept" onClick={() => handleAccept(idx)}>Accept</button>
                  <button className="diff-btn diff-btn--reject" onClick={() => handleReject(idx)}>Reject</button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      </div>

      <div className="prd-diff-footer">
        <button className="diff-btn diff-btn--ghost" onClick={handleUndo} disabled={!canUndo}>Undo</button>
        <button className="diff-btn diff-btn--primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Finalize & Save PRD'}
        </button>
      </div>
    </div>
  );
};

export default PrdDiffPanel;
