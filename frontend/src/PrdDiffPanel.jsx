import React, { useEffect, useState } from 'react';
import DiffViewer, { DiffMethod } from 'react-diff-viewer';
import { diffLines } from 'diff';
import './App.css';

// Helper to split text into lines
function splitLines(text) {
  return text.split(/\r?\n/);
}

// Helper to compute a unified diff (returns array of {type, oldLine, newLine, value})
function computeUnifiedDiff(oldLines, newLines) {
  // Simple line-by-line diff (replace with a real diff algorithm for production)
  const diff = diffLines(oldLines.join('\n'), newLines.join('\n'));
  const result = [];
  let oldLineNum = 0, newLineNum = 0;
  diff.forEach(part => {
    const lines = part.value.split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (idx === lines.length - 1 && line === '') return; // skip trailing empty
      if (part.added) {
        result.push({ type: 'added', oldLine: null, newLine: newLineNum + 1, value: line });
        newLineNum++;
      } else if (part.removed) {
        result.push({ type: 'removed', oldLine: oldLineNum + 1, newLine: null, value: line });
        oldLineNum++;
      } else {
        result.push({ type: 'unchanged', oldLine: oldLineNum + 1, newLine: newLineNum + 1, value: line });
        oldLineNum++;
        newLineNum++;
      }
    });
  });
  return result;
}

const PrdDiffPanel = ({ sessionId, refreshKey, onSave }) => {
  const [oldText, setOldText] = useState('');
  const [newText, setNewText] = useState('');
  const [diff, setDiff] = useState([]);
  const [mergedLines, setMergedLines] = useState([]); // user's accepted/rejected lines
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Fetch diff on mount (session-specific)
  useEffect(() => {
    setLoading(true);
    fetch(`/api/sessions/${sessionId}/prd/diff`)
      .then(r => {
        console.log('DIFF FETCH RESPONSE:', r);
        if (!r.ok) throw new Error('Failed to load diff');
        return r.json();
      })
      .then(data => {
        console.log('DIFF FETCH DATA:', data);
        setOldText(data.oldText || '');
        setNewText(data.newText || '');
        const oldLines = splitLines(data.oldText || '');
        const newLines = splitLines(data.newText || '');
        const unified = computeUnifiedDiff(oldLines, newLines);
        setDiff(unified);
        // Default: accept all new lines, reject removed lines
        setMergedLines(unified.map(d => d.type === 'removed' ? null : d.value));
        setLoading(false);
      })
      .catch(e => {
        console.error('DIFF FETCH ERROR:', e);
        setOldText('');
        setNewText('');
        setDiff([]);
        setMergedLines([]);
        setError('No PRD changes to review yet.');
        setLoading(false);
      });
  }, [sessionId, refreshKey]);

  // Accept a line (use new value)
  const handleAccept = idx => {
    setMergedLines(ml => ml.map((line, i) => i === idx ? diff[idx].value : line));
  };
  // Reject a line (use old value for removed, or remove added)
  const handleReject = idx => {
    if (diff[idx].type === 'added') {
      setMergedLines(ml => ml.map((line, i) => i === idx ? null : line));
    } else if (diff[idx].type === 'removed') {
      setMergedLines(ml => ml.map((line, i) => i === idx ? diff[idx].value : line));
    } else {
      // unchanged: do nothing
    }
  };

  // Finalize/save merged PRD (session-specific)
  const handleSave = () => {
    setSaving(true);
    const mergedText = mergedLines.filter(l => l !== null).join('\n');
    fetch(`/api/sessions/${sessionId}/prd/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mergedText })
    })
      .then(r => r.json())
      .then(data => {
        setSaving(false);
        if (data.ok && onSave) onSave();
      })
      .catch(e => { setError('Failed to save'); setSaving(false); });
  };

  if (loading) return <div>Loading PRD diff...</div>;
  if (error) return <div style={{ color: 'red' }}>{error}</div>;

  // Render unified diff with accept/reject controls
  return (
    <div className="prd-diff-panel">
      <h2>Review PRD Changes (Unified Diff)</h2>
      <div className="diff-unified-view">
        <pre style={{ background: '#f7f7f7', padding: 12, borderRadius: 6 }}>
          {diff.map((d, idx) => {
            let bg = d.type === 'added' ? '#e6ffed' : d.type === 'removed' ? '#ffeef0' : 'transparent';
            let textColor = d.type === 'added' ? '#22863a' : d.type === 'removed' ? '#b31d28' : '#24292e';
            let lineNum = d.type === 'added' ? '+' + d.newLine : d.type === 'removed' ? '-' + d.oldLine : ' ' + d.oldLine;
            return (
              <div key={idx} style={{ display: 'flex', alignItems: 'center', background: bg }}>
                <span style={{ width: 40, color: '#888', userSelect: 'none' }}>{lineNum}</span>
                {mergedLines[idx] !== null ? (
                  <span style={{ color: textColor, whiteSpace: 'pre-wrap', flex: 1 }}>{mergedLines[idx]}</span>
                ) : (
                  <span style={{ color: '#bbb', fontStyle: 'italic', flex: 1 }}>[removed]</span>
                )}
                {d.type !== 'unchanged' && (
                  <span style={{ marginLeft: 8 }}>
                    <button
                      style={{ marginRight: 4, background: '#e6ffed', border: '1px solid #22863a', color: '#22863a', borderRadius: 3, cursor: 'pointer' }}
                      onClick={() => handleAccept(idx)}
                      disabled={mergedLines[idx] === d.value}
                    >Accept</button>
                    <button
                      style={{ background: '#ffeef0', border: '1px solid #b31d28', color: '#b31d28', borderRadius: 3, cursor: 'pointer' }}
                      onClick={() => handleReject(idx)}
                      disabled={mergedLines[idx] !== d.value && mergedLines[idx] === null}
                    >Reject</button>
                  </span>
                )}
              </div>
            );
          })}
        </pre>
      </div>
      <button onClick={handleSave} disabled={saving} style={{ marginTop: 16, padding: '8px 20px', fontWeight: 'bold', background: '#0366d6', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
        {saving ? 'Saving...' : 'Finalize & Save PRD'}
      </button>
    </div>
  );
};

export default PrdDiffPanel;
