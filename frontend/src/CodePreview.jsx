import React, { useMemo, useState } from 'react';
import { diffLines } from 'diff';

export default function CodePreview({ sessionId, onClose }) {
  const [codeRoot, setCodeRoot] = useState('');
  const [extraPrompt, setExtraPrompt] = useState('');
  const [job, setJob] = useState(null); // { jobId, fileCount, bytes }
  const [proposing, setProposing] = useState(false);
  const [diffs, setDiffs] = useState([]); // [{ path, hunks }]
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const canScan = useMemo(() => Boolean(sessionId && codeRoot.trim()), [sessionId, codeRoot]);
  const canPropose = useMemo(() => Boolean(job && job.jobId && (job.fileCount || 0) > 0), [job]);
  const hasDiffs = diffs && diffs.length > 0;

  const handleScan = async () => {
    setError(''); setInfo(''); setLoading(true);
    try {
      const r = await fetch('/api/code/prepare', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, codeRoot })
      });
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error || 'Scan failed');
      setJob(data);
      const ignoredCount = typeof data.ignored === 'number' ? data.ignored : (Array.isArray(data.ignored) ? data.ignored.length : 0);
      setInfo(`Scanned ${data.fileCount} files, ${data.bytes} bytes (ignored: ${ignoredCount})`);
    } catch (e) {
      setError(e?.message || 'Scan failed');
    }
    setLoading(false);
  };

  const handlePropose = async () => {
    if (!job) return;
    setError(''); setInfo('Requesting proposal…'); setProposing(true);
    try {
      const r = await fetch('/api/code/propose', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, jobId: job.jobId, extraPrompt })
      });
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error || 'Propose failed');
      setInfo(`Proposed ${data.changes?.length || 0} change(s)`);
      // Fetch diffs
      const d = await fetch(`/api/code/diff/${job.jobId}?ts=${Date.now()}`, { cache: 'no-store' }).then(x => x.json());
      const mapped = (d.files || []).map(f => ({ path: f.path, parts: diffLines(f.oldText || '', f.newText || '') }));
      setDiffs(mapped);
    } catch (e) {
      setError(e?.message || 'Propose failed');
    }
    setProposing(false);
  };

  const handleAcceptAll = async () => {
    if (!job) return;
    setError(''); setInfo('Applying changes…');
    try {
      const r = await fetch(`/api/code/accept/${job.jobId}`, { method: 'POST' });
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error || 'Apply failed');
      setInfo('Applied changes.');
      setDiffs([]);
      if (typeof onClose === 'function') onClose();
    } catch (e) {
      setError(e?.message || 'Apply failed');
    }
  };

  const handleRejectAll = async () => {
    if (!job) return;
    setError(''); setInfo('Discarding proposal…');
    try {
      await fetch(`/api/code/reject/${job.jobId}`, { method: 'POST' });
      setInfo('Discarded proposal.');
      setDiffs([]);
    } catch (e) {
      setError(e?.message || 'Discard failed');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
        <label>
          Code directory path
          <input value={codeRoot} onChange={e => setCodeRoot(e.target.value)} placeholder="/Users/you/Dev/myapp" />
        </label>
        <label>
          Extra prompt (optional)
          <textarea value={extraPrompt} onChange={e => setExtraPrompt(e.target.value)} placeholder="Any extra instructions for the code changes" style={{ minHeight: 80 }} />
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={handleScan} disabled={!canScan || loading}>{loading ? 'Scanning…' : 'Scan Code'}</button>
          <button onClick={handlePropose} disabled={!canPropose || proposing}>{proposing ? 'Proposing…' : 'Propose Changes'}</button>
        </div>
        {info && <div style={{ color: '#2563eb' }}>{info}</div>}
        {error && <div style={{ color: '#b31d28' }}>{error}</div>}
      </div>

      {hasDiffs && (
        <div>
          <h3>Proposed Changes</h3>
          {diffs.map((f, i) => (
            <div key={i} style={{ border: '1px solid #ddd', marginBottom: 12, borderRadius: 6 }}>
              <div style={{ background: '#f1f8ff', padding: '6px 10px', fontFamily: 'monospace' }}>{f.path}</div>
              <pre style={{ background: '#fafbfc', margin: 0, padding: 8, whiteSpace: 'pre-wrap' }}>
                {f.parts.map((p, idx) => (
                  <span key={idx} style={{ background: p.added ? '#e6ffed' : p.removed ? '#ffeef0' : 'transparent', color: p.added ? '#22863a' : p.removed ? '#b31d28' : '#24292e' }}>{p.value}</span>
                ))}
              </pre>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleAcceptAll}>Accept All</button>
            <button onClick={handleRejectAll}>Reject All</button>
          </div>
        </div>
      )}
    </div>
  );
}
