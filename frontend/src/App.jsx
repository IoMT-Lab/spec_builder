import { useState, useRef, useEffect } from 'react';
import './App.css';
import MarkdownPanel from './MarkdownPanel.jsx';
import DraftsmanBackground from './DraftsmanBackground.jsx';
import DraftsmanPanel from './DraftsmanPanel.jsx';
import PrdDiffPanel from './PrdDiffPanel.jsx';

function App() {
  console.log('App component rendered');

  const BASE_URL="http://localhost:4000"

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

  // PRD session state
  const [prdSessionId, setPrdSessionId] = useState(null);
  const [prdStep, setPrdStep] = useState(null); // { section, field, prompt, example }
  const [prdAnswers, setPrdAnswers] = useState({});
  const [prdMode, setPrdMode] = useState(false); // true = PRD flow, false = normal LLM

  // Add a refreshKey state to trigger PRD diff panel refresh
  const [prdDiffRefreshKey, setPrdDiffRefreshKey] = useState(0);

  useEffect(() => {
    if (menuBarRef.current) {
      const rect = menuBarRef.current.getBoundingClientRect();
      setMenuBarRect({ left: rect.left, width: rect.width });
    }
  }, []);

  // Fetch sessions from backend
  const fetchSessions = async () => {
    try {
      const res = await fetch(`${BASE_URL}/api/sessions`);
      const data = await res.json();
      setSessions(data);
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
      fetch(`${BASE_URL}/api/sessions/${currentSession.id}`)
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
    // Add user message to backend
    await fetch(`${BASE_URL}/api/sessions/${currentSession.id}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user', content: userInput })
    });
    // Call LLM endpoint
    const res = await fetch(`${BASE_URL}/api/llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: userInput,
        llm: llmProvider,
        sessionId: currentSession.id
      })
    });
    const data = await res.json();
    // Add assistant message to backend
    if (data.reply) {
      await fetch(`${BASE_URL}/api/sessions/${currentSession.id}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'assistant', content: data.reply })
      });
    }
    // Always trigger PRD diff refresh after every LLM response
    setPrdDiffRefreshKey(k => k + 1);
    // Re-fetch session to update conversation
    const sessionRes = await fetch(`${BASE_URL}/api/sessions/${currentSession.id}`);
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
      const res = await fetch(`${BASE_URL}/api/llm/check`, {
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

  // Create new session
  const handleNewSession = async () => {
    const title = prompt('Enter a title for the new session:');
    if (!title) return;
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    const newSession = await res.json();
    setCurrentSession(newSession); // Use the returned session directly
    setSessions(prev => {
      // Add the new session to the list if not already present
      if (!prev.find(s => s.id === newSession.id)) {
        return [newSession, ...prev];
      }
      return prev;
    });
    await fetchSessions(); // Optionally refresh the list, but don't use it to set currentSession
    setSidebarOpen(true); // Open sidebar after creating session
    setErrorMsg(''); // Clear error on new session

    // Ensure session is available before proceeding (with retry logic)
    let sessionAvailable = false;
    for (let i = 0; i < 5; i++) {
      try {
        const checkRes = await fetch(`${BASE_URL}/api/sessions/${newSession.id}`);
        if (checkRes.ok) {
          sessionAvailable = true;
          break;
        }
      } catch (err) {}
      // Wait 200ms before retrying
      await new Promise(res => setTimeout(res, 200));
    }
    if (!sessionAvailable) {
      setErrorMsg('Session not found after creation. Please try again.');
      return;
    }

    // Trigger initial assistant message for new session
    const llmRes = await fetch(`${BASE_URL}/api/llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: '',
        llm: llmProvider,
        sessionId: newSession.id,
      }),
    });
    const llmData = await llmRes.json();
    const initialReply = llmData.reply || (llmData.error ? `Error: ${llmData.error}` : 'No reply');
    if (llmData.error) setErrorMsg(llmData.error + (llmData.details ? `\n${llmData.details.stderr || llmData.details}` : ''));
    await fetch(`${BASE_URL}/api/sessions/${newSession.id}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'assistant', content: initialReply }),
    });
    setConversation([{ role: 'assistant', content: initialReply }]);
  };

  // Start PRD flow
  const startPrdFlow = async (projectDescription, industryDomain, projectType) => {
    setLoading(true);
    setErrorMsg("");
    try {
      const res = await fetch(`${BASE_URL}/api/prd/start`, {
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
      const res = await fetch(`${BASE_URL}/api/prd/answer`, {
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

  // Handler to increment refreshKey (pass to MarkdownPanel)
  const handlePrdSave = () => setPrdDiffRefreshKey(k => k + 1);

  // Sidebar UI
  const sidebar = (
    sidebarOpen && (
      <aside className="sidebar">
        <div className="sidebar-header">
          <span>Sessions</span>
          <button className="new-session-btn" onClick={handleNewSession}>+</button>
          <button className="close-sidebar-btn" onClick={() => setSidebarOpen(false)} style={{marginLeft: 8}}>&times;</button>
        </div>
        <ul className="session-list">
          {sessions.map(s => (
            <li
              key={s.id}
              className={currentSession && s.id === currentSession.id ? 'active' : ''}
              onClick={() => setCurrentSession(s)}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
            >
              <span style={{ flex: 1, cursor: 'pointer' }}>{s.title}</span>
              <button
                className="rename-session-btn"
                title="Rename session"
                onClick={e => {
                  e.stopPropagation();
                  const newTitle = prompt('Rename session:', s.title);
                  if (newTitle && newTitle !== s.title) {
                    fetch(`/api/sessions/${s.id}`, {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ title: newTitle }),
                    })
                      .then(res => res.json())
                      .then(updated => {
                        setSessions(sessions => sessions.map(sess => sess.id === s.id ? { ...sess, title: updated.title } : sess));
                        // Re-fetch sessions to ensure up-to-date list/order
                        fetchSessions();
                      });
                  }
                }}
                style={{ marginLeft: 4, fontSize: '1rem', background: 'none', border: 'none', cursor: 'pointer', color: '#6366f1' }}
              >✏️</button>
              <button
                className="delete-session-btn"
                title="Delete session"
                onClick={e => {
                  e.stopPropagation();
                  if (window.confirm('Delete this session and its PRD?')) {
                    fetch(`/api/sessions/${s.id}`, { method: 'DELETE' })
                      .then(res => res.json())
                      .then(() => {
                        setSessions(sessions => sessions.filter(sess => sess.id !== s.id));
                        if (currentSession && currentSession.id === s.id) {
                          setCurrentSession(sessions.find(sess => sess.id !== s.id) || null);
                        }
                        // Re-fetch sessions to ensure up-to-date list/order
                        fetchSessions();
                      });
                  }
                }}
                style={{ marginLeft: 4, fontSize: '1rem', background: 'none', border: 'none', cursor: 'pointer', color: '#e11d48' }}
              >🗑️</button>
            </li>
          ))}
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
    <div className="app-container" style={{ position: 'relative', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <DraftsmanBackground />
      {topMenu}
      <div className="app-main">
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
                    <PrdDiffPanel sessionId={currentSession.id} refreshKey={prdDiffRefreshKey} />
                  )}
                  <MarkdownPanel sessionId={currentSession ? currentSession.id : null} onSave={handlePrdSave} />
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
