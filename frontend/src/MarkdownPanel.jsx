import React, { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';

export default function MarkdownPanel({ sessionId, onSave, refreshKey }) {
  const [markdown, setMarkdown] = useState('');
  const [editMode, setEditMode] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [saveStatus, setSaveStatus] = useState('');

  // Fetch PRD for session
  useEffect(() => {
    if (!sessionId) {
      setMarkdown('No session selected.');
      return;
    }
    setLoading(true);
    fetch(`/api/sessions/${sessionId}`, { cache: 'no-store' })
      .then(res => res.json())
      .then(session => {
        if (!session.prdPath) throw new Error('No PRD path');
        const ts = Date.now();
        return fetch(`/api/sessions/${sessionId}/prd?ts=${ts}`, { headers: { 'Accept': 'text/markdown' }, cache: 'no-store' });
      })
      .then(res => res.text())
      .then(text => {
        setMarkdown(text);
        setEditValue(text);
        setLoading(false);
      })
      .catch((err) => {
        setMarkdown('Could not load PRD markdown.');
        setEditValue('');
        setLoading(false);
      });
  }, [sessionId, refreshKey]);

  // Save PRD
  const handleSave = async () => {
    setSaveStatus('Saving...');
    try {
      const res = await fetch(`/api/sessions/${sessionId}/prd`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prdContent: editValue }),
      });
      if (res.ok) {
        setMarkdown(editValue);
        setSaveStatus('Saved!');
        setEditMode(false);
        if (onSave) onSave(); // Trigger PRD diff refresh
      } else {
        setSaveStatus('Save failed.');
      }
    } catch {
      setSaveStatus('Save failed.');
    }
    setTimeout(() => setSaveStatus(''), 1500);
  };

  if (!sessionId) return <div className="markdown-panel glass"><div className="markdown-panel-content">No session selected.</div></div>;

  return (
    <div className="markdown-panel glass">
      <div className="markdown-panel-content">
        {loading ? (
          <div>Loading PRD...</div>
        ) : editMode ? (
          <>
            <textarea
              value={editValue}
              onChange={e => setEditValue(e.target.value)}
              style={{ width: '100%', minHeight: 180, fontFamily: 'inherit', fontSize: '1rem' }}
            />
            <div style={{ marginTop: 8 }}>
              <button onClick={handleSave} style={{ marginRight: 8 }}>Save</button>
              <button onClick={() => setEditMode(false)}>Cancel</button>
              <span style={{ marginLeft: 12, color: '#2563eb' }}>{saveStatus}</span>
            </div>
          </>
        ) : (
          <>
            <ReactMarkdown>{markdown}</ReactMarkdown>
            <button style={{ marginTop: 12 }} onClick={() => setEditMode(true)}>Edit PRD</button>
          </>
        )}
      </div>
    </div>
  );
}
