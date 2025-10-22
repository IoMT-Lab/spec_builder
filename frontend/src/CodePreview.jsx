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
    setError('');
    setInfo('');
    setLoading(true);
    try {
      const r = await fetch('/api/code/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, codeRoot })
      });
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error || 'Scan failed');
      setJob(data);
      const ignoredCount = typeof data.ignored === 'number'
        ? data.ignored
        : (Array.isArray(data.ignored) ? data.ignored.length : 0);
      setInfo(`Scanned ${data.fileCount} files · ${data.bytes} bytes (ignored ${ignoredCount})`);
    } catch (e) {
      setError(e?.message || 'Scan failed');
    }
    setLoading(false);
  };

  const handlePropose = async () => {
    if (!job) return;
    setError('');
    setInfo('Requesting proposal…');
    setProposing(true);
    try {
      const r = await fetch('/api/code/propose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, jobId: job.jobId, extraPrompt })
      });
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error || 'Propose failed');
      setInfo(`Proposed ${data.changes?.length || 0} change(s)`);
      const d = await fetch(`/api/code/diff/${job.jobId}?ts=${Date.now()}`, { cache: 'no-store' }).then(x => x.json());
      const mapped = (d.files || []).map(f => ({
        path: f.path,
        parts: diffLines(f.oldText || '', f.newText || '')
      }));
      setDiffs(mapped);
    } catch (e) {
      setError(e?.message || 'Propose failed');
    }
    setProposing(false);
  };

  const handleAcceptAll = async () => {
    if (!job) return;
    setError('');
    setInfo('Applying changes…');
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
    setError('');
    setInfo('Discarding proposal…');
    try {
      await fetch(`/api/code/reject/${job.jobId}`, { method: 'POST' });
      setInfo('Discarded proposal.');
      setDiffs([]);
    } catch (e) {
      setError(e?.message || 'Discard failed');
    }
  };

  const renderStatusBanner = () => {
    if (!info && !error) return null;
    const isError = Boolean(error);
    const message = error || info;
    const styles = {
      background: isError ? '#ffeef0' : '#e6ffed',
      border: `1px solid ${isError ? '#b31d28' : '#22863a'}`,
      color: isError ? '#86181d' : '#1c5322',
      padding: '8px 12px',
      borderRadius: 6,
      fontSize: 14
    };
    return (
      <div style={styles}>
        {message}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section style={{ border: '1px solid #d0d7de', borderRadius: 8, padding: 16, background: '#f9fafb' }}>
        <header style={{ marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Scan Settings</h3>
          <p style={{ margin: '4px 0 0', color: '#57606a', fontSize: 13 }}>
            Point to the code you want analysed and optionally add instructions before requesting a proposal.
          </p>
        </header>
        <div style={{ display: 'grid', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontWeight: 600 }}>Code directory path</span>
            <input
              value={codeRoot}
              onChange={e => setCodeRoot(e.target.value)}
              placeholder="/Users/you/Dev/spec_builder"
              style={{ padding: '8px 10px', border: '1px solid #d0d7de', borderRadius: 6 }}
            />
            <small style={{ color: '#6e7781' }}>Use an absolute path that the backend can access.</small>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontWeight: 600 }}>Extra prompt (optional)</span>
            <textarea
              value={extraPrompt}
              onChange={e => setExtraPrompt(e.target.value)}
              placeholder="Any extra instructions for the code changes"
              style={{ minHeight: 100, padding: '8px 10px', border: '1px solid #d0d7de', borderRadius: 6 }}
            />
          </label>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <button
              onClick={handleScan}
              disabled={!canScan || loading}
              style={{ padding: '8px 14px', borderRadius: 6 }}
            >
              {loading ? 'Scanning…' : 'Scan Code'}
            </button>
            <button
              onClick={handlePropose}
              disabled={!canPropose || proposing}
              style={{ padding: '8px 14px', borderRadius: 6 }}
            >
              {proposing ? 'Proposing…' : 'Propose Changes'}
            </button>
          </div>
          {renderStatusBanner()}
        </div>
      </section>

      {hasDiffs && (
        <section style={{ border: '1px solid #d0d7de', borderRadius: 8, background: '#ffffff', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <header style={{ padding: '12px 16px', borderBottom: '1px solid #d0d7de', background: '#f6f8fa' }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>Proposed Changes</h3>
            <p style={{ margin: '4px 0 0', color: '#57606a', fontSize: 13 }}>
              Review the suggested edits below. Accepting will apply all changes to disk.
            </p>
          </header>
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, maxHeight: 320, overflowY: 'auto' }}>
            {diffs.map((f, i) => (
              <div key={i} style={{ border: '1px solid #d8dee4', borderRadius: 6 }}>
                <div style={{ background: '#f1f8ff', padding: '6px 10px', fontFamily: 'monospace', fontSize: 13 }}>{f.path}</div>
                <pre style={{ background: '#fafbfc', margin: 0, padding: 10, whiteSpace: 'pre-wrap', fontSize: 13 }}>
                  {f.parts.map((p, idx) => (
                    <span
                      key={idx}
                      style={{
                        background: p.added ? '#e6ffed' : p.removed ? '#ffeef0' : 'transparent',
                        color: p.added ? '#1d4f2b' : p.removed ? '#86181d' : '#24292e'
                      }}
                    >
                      {p.value}
                    </span>
                  ))}
                </pre>
              </div>
            ))}
          </div>
          <footer style={{ borderTop: '1px solid #d0d7de', padding: '12px 16px', display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button onClick={handleRejectAll} style={{ padding: '8px 14px', borderRadius: 6 }}>Reject All</button>
            <button onClick={handleAcceptAll} style={{ padding: '8px 14px', borderRadius: 6 }}>Accept All</button>
          </footer>
        </section>
      )}

      {!hasDiffs && job && (
        <section style={{ border: '1px dashed #d0d7de', borderRadius: 8, padding: 16, color: '#57606a', background: '#ffffff' }}>
          No diffs yet. Run <strong>Propose Changes</strong> once the scan is complete to view suggestions here.
        </section>
      )}
    </div>
  );
}
