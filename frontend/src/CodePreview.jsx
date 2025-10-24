import React, { useMemo, useState } from 'react';
import { diffLines } from 'diff';

export default function CodePreview({ sessionId, onClose }) {
  const [codeRoot, setCodeRoot] = useState('');
  const [extraPrompt, setExtraPrompt] = useState('');
  const [job, setJob] = useState(null); // { jobId, fileCount, bytes, ignored }
  const [fileList, setFileList] = useState([]); // [{ path, size }]
  const [selectedPaths, setSelectedPaths] = useState([]);
  const [proposing, setProposing] = useState(false);
  const [diffs, setDiffs] = useState([]); // [{ path, hunks }]
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [warnings, setWarnings] = useState([]);

  const canScan = useMemo(() => Boolean(sessionId && codeRoot.trim()), [sessionId, codeRoot]);
  const canPropose = useMemo(
    () => Boolean(sessionId && job?.jobId && selectedPaths.length && !proposing),
    [sessionId, job, selectedPaths, proposing]
  );
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
      const ignoredCount = typeof data.ignored === 'number'
        ? data.ignored
        : (Array.isArray(data.ignored) ? data.ignored.length : 0);
      setInfo(`Scanned ${data.fileCount} files · ${data.bytes} bytes (ignored ${ignoredCount})`);
      const files = Array.isArray(data.files) ? data.files : [];
      const recommended = Array.isArray(data.recommended) ? data.recommended.map(String) : [];
      const augmented = [...files];
      recommended.forEach(path => {
        if (!augmented.some(f => f.path === path)) augmented.push({ path, size: null, synthetic: true });
      });
      setJob({
        jobId: data.jobId,
        fileCount: data.fileCount,
        bytes: data.bytes,
        ignored: ignoredCount,
        recommendedPrompt: data.recommendedPrompt || ''
      });
      setWarnings(Array.isArray(data.warnings) ? data.warnings : []);
      setFileList(augmented);
      if (recommended.length) {
        setSelectedPaths(recommended);
      } else {
        setSelectedPaths(files.length ? [files[0].path] : []);
      }
      if ((data.recommendedPrompt || '').trim()) {
        setExtraPrompt(prev => prev ? prev : data.recommendedPrompt.trim());
      }
    } catch (e) {
      setError(e?.message || 'Scan failed');
    }
    setLoading(false);
  };

  const handlePropose = async () => {
    if (!job?.jobId) {
      setError('Scan code before proposing changes.');
      return;
    }
    if (!selectedPaths.length) {
      setError('Select at least one file to include.');
      return;
    }
    setError('');
    setInfo('Requesting proposal…');
    setProposing(true);
    try {
      const r = await fetch('/api/codegen/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          codeRoot,
          jobId: job.jobId,
          files: selectedPaths,
          extraPrompt
        })
      });
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error || 'Code generation failed');
      setJob({
        jobId: data.jobId,
        fileCount: data.fileCount,
        bytes: data.bytes,
        ignored: data.ignored,
        recommendedPrompt: data.recommendedPrompt || ''
      });
      setWarnings(Array.isArray(data.warnings) ? data.warnings : []);
      if ((data.recommendedPrompt || '').trim()) {
        setExtraPrompt(prev => prev ? prev : data.recommendedPrompt.trim());
      }
      if (Array.isArray(data.files)) {
        const files = data.files;
        const augmented = [...files];
        const currentSelected = selectedPaths.length ? selectedPaths : [];
        currentSelected.forEach(path => {
          if (!augmented.some(f => f.path === path)) augmented.push({ path, size: null, synthetic: true });
        });
        setFileList(augmented);
        setSelectedPaths(prev => {
          const allowed = augmented.map(f => f.path);
          const filtered = prev.filter(p => allowed.includes(p));
          return filtered.length ? filtered : (allowed.length ? [allowed[0]] : []);
        });
      }
      setInfo(`Proposed ${data.changes?.length || 0} change(s)`);
      const mapped = (data.diff || []).map(f => ({
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
    if (!job?.jobId) return;
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
    if (!job?.jobId) return;
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

  const renderWarningsBanner = () => {
    if (!warnings.length) return null;
    return (
      <div style={{
        background: '#fff7ed',
        border: '1px solid #d97706',
        color: '#92400e',
        padding: '8px 12px',
        borderRadius: 6,
        fontSize: 13
      }}>
        {warnings.map((w, i) => (
          <div key={i} style={{ marginBottom: i === warnings.length - 1 ? 0 : 4 }}>
            ⚠️ {w}
          </div>
        ))}
      </div>
    );
  };

  const togglePath = (path) => {
    setSelectedPaths(prev => (
      prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path]
    ));
  };

  const selectAll = () => {
    setSelectedPaths(fileList.map(f => f.path));
  };

  const clearAll = () => {
    setSelectedPaths([]);
  };

  const formatSize = (bytes) => {
    if (typeof bytes !== 'number' || Number.isNaN(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
    return `${Math.round(bytes / 104857.6) / 10} MB`;
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
        {renderWarningsBanner()}
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
          {fileList.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 600 }}>Files to include ({selectedPaths.length}/{fileList.length})</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={selectAll} style={{ padding: '4px 8px', borderRadius: 4 }}>Select all</button>
                  <button type="button" onClick={clearAll} style={{ padding: '4px 8px', borderRadius: 4 }}>Clear</button>
                </div>
              </div>
              <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid #d0d7de', borderRadius: 6, padding: 8, background: '#fff' }}>
                {fileList.map(file => (
                  <label
                    key={file.path}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '4px 0' }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedPaths.includes(file.path)}
                      onChange={() => togglePath(file.path)}
                    />
                    <span style={{ flex: 1 }}>{file.path}</span>
                    {file.size != null && (
                      <span style={{ color: '#6e7781' }}>{formatSize(file.size)}</span>
                    )}
                  </label>
                ))}
                {fileList.length === 0 && (
                  <div style={{ color: '#6e7781', fontSize: 13 }}>No files detected under the selected path.</div>
                )}
              </div>
            </div>
          )}
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
          No diffs yet. Run <strong>Propose Changes</strong> to generate suggestions and review them here.
        </section>
      )}
    </div>
  );
}
