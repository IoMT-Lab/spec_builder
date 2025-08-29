import { useState, useRef, useEffect } from 'react';
import './App.css';
import MarkdownPanel from './MarkdownPanel.jsx';
import DraftsmanBackground from './DraftsmanBackground.jsx';
import DraftsmanPanel from './DraftsmanPanel.jsx';
import PrdDiffPanel from './PrdDiffPanel.jsx';

function App() {
  console.log('App component rendered');

  const [expandedPanel, setExpandedPanel] = useState(null);
  const [llmProvider, setLlmProvider] = useState('openai');
  const [apiCheckResult, setApiCheckResult] = useState('');
  const [apiCheckLoading, setApiCheckLoading] = useState(false);
  // Session state
  const [sessions, setSessions] = useState([]);
  const [currentSession, setCurrentSession] = useState(null);
  const [conversation, setConversation] = useState([]); // Now session-aware
  const [userInput, setUserInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const menuBarRef = useRef(null);
  const [menuBarRect, setMenuBarRect] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const ORDER_KEY = 'session_order_v1';
  const loadOrder = () => {
    try { return JSON.parse(localStorage.getItem(ORDER_KEY)) || []; } catch { return []; }
  };
  const saveOrder = (ids) => {
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(ids)); } catch {}
  };
  const applyOrder = (arr) => {
    const order = loadOrder();
    const idx = new Map(order.map((id, i) => [id, i]));
    return [...arr].sort((a, b) => (idx.has(a.id) ? idx.get(a.id) : 1e9) - (idx.has(b.id) ? idx.get(b.id) : 1e9));
  };

  // PRD session state
  const [prdSessionId, setPrdSessionId] = useState(null);
  const [prdStep, setPrdStep] = useState(null); // { section, field, prompt, example }
  const [prdAnswers, setPrdAnswers] = useState({});
  const [prdMode, setPrdMode] = useState(false); // true = PRD flow, false = normal LLM

  // Add refresh keys to trigger PRD diff and markdown refresh
  const [prdDiffRefreshKey, setPrdDiffRefreshKey] = useState(0);
  const [markdownRefreshKey, setMarkdownRefreshKey] = useState(0);

  useEffect(() => {
    if (menuBarRef.current) {
      const rect = menuBarRef.current.getBoundingClientRect();
      setMenuBarRect({ left: rect.left, width: rect.width });
    }
  }, []);

  // Fetch sessions from backend
  const fetchSessions = async () => {
    try {
      const res = await fetch('/api/sessions');
      const data = await res.json();
      setSessions(applyOrder(data));
      // If currentSession is missing or deleted, select the first available
      if (!data.find(s => currentSession && s.id === currentSession.id)) {
        setCurrentSession(data[0] || null);
      }
    } catch (err) {
      setSessions([]);
      setCurrentSession(null);
    }
  };

  // Fetch sessions on mount
  useEffect(() => {
    fetchSessions();
  }, []);

  // Reload sessions when menu is opened
  const handleSidebarOpen = () => {
    setSidebarOpen(v => {
      if (!v) fetchSessions();
      return !v;
    });
  };

  // Load session when selected or sessions change
  useEffect(() => {
    if (!currentSession && sessions.length > 0) {
      setCurrentSession(sessions[0]);
    }
  }, [sessions]);

  // Fetch conversation for current session
  useEffect(() => {
    if (currentSession) {
      fetch(`/api/sessions/${currentSession.id}`)
        .then(res => res.json())
        .then(session => setConversation(session.conversation || []))
        .catch(() => setConversation([]));
    } else {
      setConversation([]);
    }
  }, [currentSession]);

  const panels = [
    {
      key: 'assurance',
      title: 'Assurance Case Structure',
    },
    {
      key: 'graph',
      title: 'Graph Visualizer window',
    },
    {
      key: 'code',
      title: 'Code Preview Window',
    },
  ];

  // Send message for current session
  const handleSend = async () => {
    if (!userInput.trim() || !currentSession) return;
    setLoading(true);
    // Call LLM endpoint
    const res = await fetch('/api/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: userInput,
        llm: llmProvider,
        sessionId: currentSession.id
      })
    });
    const data = await res.json();
    // Always trigger PRD diff refresh after every LLM response
    setPrdDiffRefreshKey(k => k + 1);
    // Re-fetch session to update conversation
    const sessionRes = await fetch(`/api/sessions/${currentSession.id}`);
    const sessionData = await sessionRes.json();
    setConversation(sessionData.conversation || []);
    setUserInput('');
    setLoading(false);
  };

  const handleInputKeyDown = (e) => {
    if (e.key === 'Enter' && !loading) {
      handleSend();
    }
  };

  const handleCheckApiKey = async () => {
    setApiCheckLoading(true);
    setApiCheckResult('');
    try {
      const res = await fetch('/api/llm/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ llm: llmProvider }),
      });
      const data = await res.json();
      if (data.ok) {
        setApiCheckResult('API key is valid and model access confirmed.');
      } else {
        setApiCheckResult(data.error ? `Error: ${data.error}` : 'Unknown error');
      }
    } catch (err) {
      setApiCheckResult('Error contacting backend');
    }
    setApiCheckLoading(false);
  };

  // Delete session (optimistic)
  const handleDeleteSession = async (id) => {
    try {
      setSessions(prev => {
        const next = prev.filter(s => s.id !== id);
        saveOrder(next.map(s => s.id));
        if (currentSession && currentSession.id === id) {
          setCurrentSession(next[0] || null);
        }
        return next;
      });
      await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    } catch (err) {
      console.warn('Delete session failed:', err);
      // Non-fatal: UI already updated; if needed, user can refresh sessions list
    }
  };

  // Create new session
  const handleNewSession = async () => {
    try {
      // Prompt for title (fallback to default if blocked/cancelled)
      let title = undefined;
      try { title = prompt('Enter a title for the new session:'); } catch {}
      if (!title || !String(title).trim()) {
        const ts = new Date();
        title = `Session ${ts.getFullYear()}-${String(ts.getMonth()+1).padStart(2,'0')}-${String(ts.getDate()).padStart(2,'0')} ${String(ts.getHours()).padStart(2,'0')}:${String(ts.getMinutes()).padStart(2,'0')}`;
      }

      // Optimistic local add so the UI responds instantly
      const tempId = 'tmp-' + Date.now();
      const tempSession = { id: tempId, title, conversation: [], prdDraft: '', prdPath: '', conversationPath: '' };
      setSessions(prev => {
        const next = [tempSession, ...prev];
        saveOrder(next.map(s => s.id));
        return next;
      });
      setCurrentSession(tempSession);
      setSidebarOpen(true);
      setErrorMsg('');

      // Create on server
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) throw new Error(`Create failed (${res.status})`);
      const serverSession = await res.json();

      // Replace temp with server session
      setSessions(prev => prev.map(s => s.id === tempId ? serverSession : s));
      setCurrentSession(serverSession);

      // Kick off initial assistant message (non-blocking)
      try {
        const llmRes = await fetch('/api/llm', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: '', llm: llmProvider, sessionId: serverSession.id })
        });
        const llmData = await llmRes.json();
        // Refresh conversation from server (LLM endpoint already persists it)
        try {
          const sessionRes = await fetch(`/api/sessions/${serverSession.id}`);
          const sessionData = await sessionRes.json();
          setConversation(sessionData.conversation || []);
        } catch {}
        if (llmData.error) setErrorMsg(llmData.error + (llmData.details ? `\n${llmData.details.stderr || llmData.details}` : ''));
      } catch (e) {
        // Non-fatal; surface minimal info
        console.warn('Initial LLM message failed:', e);
      }
    } catch (err) {
      console.error('New session failed:', err);
      setErrorMsg('Failed to create session. Is the backend running?');
    }
  };

  // Start PRD flow
  const startPrdFlow = async (projectDescription, industryDomain, projectType) => {
    setLoading(true);
    setErrorMsg("");
    try {
      const res = await fetch('/api/prd/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectDescription, industryDomain, projectType })
      });
      const data = await res.json();
      if (data.sessionId) {
        setPrdSessionId(data.sessionId);
        setPrdStep({ section: data.section, field: data.field, prompt: data.prompt, example: data.example });
        setPrdAnswers({});
        setPrdMode(true);
        setConversation([{ role: 'assistant', content: data.prompt + (data.example ? `\nExample: ${data.example}` : '') }]);
      } else {
        setErrorMsg(data.error || 'Failed to start PRD flow');
      }
    } catch (err) {
      setErrorMsg('Error contacting backend');
    }
    setLoading(false);
  };

  // PRD step handler
  const handlePrdStep = async (userInput) => {
    if (!prdSessionId || !prdStep) return;
    setLoading(true);
    setErrorMsg("");
    setConversation(prev => [...prev, { role: 'user', content: userInput }]);
    try {
      const res = await fetch('/api/prd/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: prdSessionId, section: prdStep.section, field: prdStep.field, answer: userInput })
      });
      const data = await res.json();
      if (data.done) {
        setPrdMode(false);
        setConversation(prev => [...prev, { role: 'assistant', content: 'PRD complete! You can now preview or export your PRD.' }]);
        setPrdStep(null);
        setPrdSessionId(null);
      } else {
        // LLM-driven: just show the prompt from the LLM
        setPrdStep(null); // No longer tracking section/field
        setConversation(prev => [...prev, { role: 'assistant', content: data.prompt }]);
      }
      // Optionally, still track answers by last step
      setPrdAnswers(prev => ({ ...prev, [prdStep?.section || 'last']: { ...(prev[prdStep?.section || 'last'] || {}), [prdStep?.field || 'last']: userInput } }));
    } catch (err) {
      setErrorMsg('Error contacting backend');
    }
    setUserInput('');
    setLoading(false);
  };

  // Handler to increment refresh keys (used by diff merge and manual save)
  const handlePrdSave = () => {
    setPrdDiffRefreshKey(k => k + 1);
    setMarkdownRefreshKey(k => k + 1);
  };

  // Sidebar UI
  const sidebar = (
    sidebarOpen && (
      <aside className="sidebar">
        <div className="sidebar-header">
          <span>Sessions</span>
          <button
            type="button"
            className="new-session-btn"
            onMouseDown={(e)=>{ e.preventDefault(); e.stopPropagation(); handleNewSession(); }}
            onClick={handleNewSession}
          >+
          </button>
          <button className="close-sidebar-btn" onClick={() => setSidebarOpen(false)} style={{marginLeft: 8}}>&times;</button>
        </div>
        <ul className="session-list">
          {sessions.map((s) => (
            <li
              key={s.id}
              className={(currentSession && s.id === currentSession.id ? 'active ' : '')}
            >
              <span
                className="session-title"
                onMouseDown={(e)=>{ e.preventDefault(); e.stopPropagation(); setCurrentSession(s); }}
                onClick={() => setCurrentSession(s)}
              >{s.title}</span>
              <span className="session-actions">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Rename session"
                  title="Rename session"
                  onMouseDown={(e)=>{ e.stopPropagation(); }}
                  onClick={(e) => { e.stopPropagation();
                    const newTitle = prompt('Rename session:', s.title);
                    if (newTitle && newTitle !== s.title) {
                      fetch(`/api/sessions/${s.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: newTitle }) })
                        .then(res => res.json())
                        .then(updated => setSessions(list => list.map(sess => sess.id === s.id ? { ...sess, title: updated.title } : sess)));
                    }
                  }}
                >
                  <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 20h4l10-10-4-4L4 16v4Z"/>
                    <path d="M14 6l4 4"/>
                  </svg>
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Delete session"
                  title="Delete session"
                  onPointerDown={(e)=>{ e.stopPropagation(); }}
                  onClick={(e)=>{ e.stopPropagation(); if (window.confirm('Delete this session and its PRD?')) handleDeleteSession(s.id); }}
                >
                  <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M5 7h14"/>
                    <path d="M7 7l1 12h8l1-12"/>
                    <path d="M9 7V5h6v2"/>
                  </svg>
                </button>
              </span>
              </li>
          ))}
          {/* no drag indicators */}
        </ul>
        <div className="sidebar-section">
          <label htmlFor="llm-select" className="llm-select-label">LLM:</label>
          <select
            id="llm-select"
            className="llm-select"
            value={llmProvider}
            onChange={(e) => setLlmProvider(e.target.value)}
          >
            <option value="openai">OpenAI ChatGPT</option>
            <option value="gemini">Google Gemini</option>
          </select>
          <button
            className="check-api-btn"
            onClick={handleCheckApiKey}
            disabled={apiCheckLoading}
            style={{ marginLeft: 12, marginTop: 8 }}
          >
            {apiCheckLoading ? 'Checking...' : 'Check API Key'}
          </button>
          {apiCheckResult && (
            <div className="api-check-result" style={{ marginTop: 8 }}>{apiCheckResult}</div>
          )}
        </div>
      </aside>
    )
  );

  // Top menu bar with menu button
  const topMenu = (
    <div className="menu-bar">
      <span className="menu-icon" onClick={handleSidebarOpen} style={{cursor: 'pointer', fontSize: '1.7rem'}}>&#9776;</span>
      <span className="menu-title">LLM Web App</span>
    </div>
  );

  // Global error handler for debugging
  useEffect(() => {
    window.addEventListener('unhandledrejection', event => {
      console.error('Unhandled promise rejection:', event.reason);
    });
    window.addEventListener('error', event => {
      console.error('Global error:', event.error || event.message);
    });
    return () => {
      window.removeEventListener('unhandledrejection', () => {});
      window.removeEventListener('error', () => {});
    };
  }, []);

  return (
    <div className={`app-container`} style={{ position: 'relative', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <DraftsmanBackground />
      {topMenu}
      {sidebarOpen && (
        <div
          className="sidebar-backdrop"
          onMouseDown={() => setSidebarOpen(false)}
        />
      )}
      <div className={`app-main`}>
        {sidebar}
        <div className="main-content">
          {/* Top Panels Row */}
          {expandedPanel === null ? (
            <section className="top-panels">
              <DraftsmanPanel
                label={<span>assurance_case_structure</span>}
                expand={<span onClick={() => setExpandedPanel('assurance')} title="Expand">&#8599;</span>}
                className="top-panel"
              />
              <DraftsmanPanel
                label={<span>graph_visualizer</span>}
                expand={<span onClick={() => setExpandedPanel('graph')} title="Expand">&#8599;</span>}
                className="top-panel"
              />
              <DraftsmanPanel
                label={<span>code_preview</span>}
                expand={<span onClick={() => setExpandedPanel('code')} title="Expand">&#8599;</span>}
                className="top-panel"
              />
            </section>
          ) : (
            <div className="expanded-panel-overlay">
              <div className="expanded-panel">
                <div className="expanded-panel-title">
                  {panels.find((p) => p.key === expandedPanel)?.title}
                </div>
                <button
                  className="panel-collapse"
                  onClick={() => setExpandedPanel(null)}
                  title="Collapse"
                >
                  &times;
                </button>
                {/* Expanded panel content goes here */}
              </div>
            </div>
          )}

          {/* LLM Replies + Markdown Row */}
          {expandedPanel === null && (
            <div className="llm-markdown-row">
              <section className="llm-replies">
                <div className="llm-replies-title">LLM REPLIES</div>
                <div className="llm-replies-content">
                  {errorMsg && (
                    <div style={{ color: 'red', whiteSpace: 'pre-wrap', marginBottom: 12, fontWeight: 500 }}>
                      {errorMsg}
                    </div>
                  )}
                  {conversation.length === 0 && !loading && 'LLM Replies go here'}
                  {conversation.map((msg, idx) => (
                    <div key={idx} className={msg.role === 'user' ? 'user-msg' : 'assistant-msg'} style={{ textAlign: msg.role === 'user' ? 'right' : 'left', margin: '8px 0' }}>
                      <b>{msg.role === 'user' ? 'You' : 'LLM'}:</b> {msg.content}
                    </div>
                  ))}
                  {loading && <div>Loading...</div>}
                </div>
              </section>
              <div className="markdown-panel">
                <div className="markdown-panel-content">
                  {/* Show PRD diff panel if a temp draft exists */}
                  {currentSession && (
                    <PrdDiffPanel sessionId={currentSession.id} refreshKey={prdDiffRefreshKey} onSave={handlePrdSave} />
                  )}
                  <MarkdownPanel sessionId={currentSession ? currentSession.id : null} onSave={handlePrdSave} refreshKey={markdownRefreshKey} />
                </div>
              </div>
            </div>
          )}

          {/* User Input Bar at Bottom */}
          <footer className="user-input-bar">
            <button className="send-btn" onClick={handleSend} disabled={loading || !currentSession}>
              &#187;&#187;
            </button>
            <input
              className="user-input"
              type="text"
              placeholder="User input is typed here"
              value={userInput}
              onChange={e => setUserInput(e.target.value)}
              onKeyDown={handleInputKeyDown}
              disabled={loading || !currentSession}
            />
          </footer>
        </div>
      </div>
    </div>
  );
}

export default App;
