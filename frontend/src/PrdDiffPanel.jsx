import React, { useEffect, useMemo, useState } from 'react';
import { diffLines } from 'diff';
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

const PrdDiffPanel = ({ sessionId, refreshKey, onSave }) => {
  // Left (working) and right (proposal) texts as arrays of lines
  const [leftLines, setLeftLines] = useState([]);
  const [rightLines, setRightLines] = useState([]);
  const [diff, setDiff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState([]); // stack of { left, right }

  // Load initial pair (main PRD vs temp draft)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/sessions/${sessionId}/prd/diff`)
      .then(r => {
        if (!r.ok) throw new Error('Failed to load diff');
        return r.json();
      })
      .then(data => {
        if (cancelled) return;
        const left = splitLines(data.oldText || '');
        const right = splitLines(data.newText || '');
        setLeftLines(left);
        setRightLines(right);
        setHistory([]);
        setLoading(false);
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
      });
    return () => { cancelled = true; };
  }, [sessionId, refreshKey]);

  // Recompute diff whenever left/right change
  useEffect(() => {
    setDiff(computeUnifiedDiff(leftLines, rightLines));
  }, [leftLines, rightLines]);

  const canUndo = history.length > 0;
  const hasChanges = useMemo(() => diff.some(d => d.type !== 'unchanged'), [diff]);

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

  // Save the merged working document (left)
  const handleSave = () => {
    setSaving(true);
    const mergedText = leftLines.join('\n');
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
        }
      })
      .catch(e => { setError('Failed to save'); setSaving(false); });
  };

  if (loading) return <div>Loading PRD diff...</div>;
  if (error) return <div style={{ color: 'red' }}>{error}</div>;
  if (!hasChanges) return null; // Hide panel when there are no differences

  return (
    <div className="prd-diff-panel">
      <h2>Review PRD Changes (Unified Diff)</h2>
      <div className="diff-unified-view">
        <pre style={{ background: '#f7f7f7', padding: 12, borderRadius: 6 }}>
          {diff.map((d, idx) => {
            const bg = d.type === 'added' ? '#e6ffed' : d.type === 'removed' ? '#ffeef0' : 'transparent';
            const textColor = d.type === 'added' ? '#22863a' : d.type === 'removed' ? '#b31d28' : '#24292e';
            const lineNum = d.type === 'added' ? '+' + d.newLine : d.type === 'removed' ? '-' + d.oldLine : ' ' + d.oldLine;
            return (
              <div key={idx} style={{ display: 'flex', alignItems: 'center', background: bg }}>
                <span style={{ width: 40, color: '#888', userSelect: 'none' }}>{lineNum}</span>
                <span style={{ color: textColor, whiteSpace: 'pre-wrap', flex: 1 }}>{d.value}</span>
                {d.type !== 'unchanged' && (
                  <span style={{ marginLeft: 8 }}>
                    <button
                      style={{ marginRight: 4, background: '#e6ffed', border: '1px solid #22863a', color: '#22863a', borderRadius: 3, cursor: 'pointer' }}
                      onClick={() => handleAccept(idx)}
                    >Accept</button>
                    <button
                      style={{ background: '#ffeef0', border: '1px solid #b31d28', color: '#b31d28', borderRadius: 3, cursor: 'pointer' }}
                      onClick={() => handleReject(idx)}
                    >Reject</button>
                  </span>
                )}
              </div>
            );
          })}
        </pre>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button onClick={handleUndo} disabled={!canUndo} style={{ padding: '8px 16px' }}>Undo</button>
        <button onClick={handleSave} disabled={saving} style={{ padding: '8px 20px', fontWeight: 'bold', background: '#0366d6', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
          {saving ? 'Saving...' : 'Finalize & Save PRD'}
        </button>
      </div>
    </div>
  );
};

export default PrdDiffPanel;
