import { useState, useRef, useEffect } from 'react';
import './App.css';
import ReactMarkdown from 'react-markdown';
import MarkdownPanel from './MarkdownPanel.jsx';
import DraftsmanBackground from './DraftsmanBackground.jsx';
import DraftsmanPanel from './DraftsmanPanel.jsx';
import PrdDiffPanel from './PrdDiffPanel.jsx';
import CodePreview from './CodePreview.jsx';

function App() {
  console.log('App component rendered');

  const [expandedPanel, setExpandedPanel] = useState(null);
  const [llmProvider, setLlmProvider] = useState(
    (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_DEFAULT_LLM) || 'gpt5'
  );
  const [apiCheckResult, setApiCheckResult] = useState('');
  const [apiCheckLoading, setApiCheckLoading] = useState(false);
  // Session state
  const [sessions, setSessions] = useState([]);
  const [currentSession, setCurrentSession] = useState(null);
  const [conversation, setConversation] = useState([]); // Now session-aware
  const [userInput, setUserInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [awaitingConfirm, setAwaitingConfirm] = useState(null); // { sectionIndex, fieldIndex, summaryText }
  const [creatingSession, setCreatingSession] = useState(false);
  const [infoMsg, setInfoMsg] = useState('');
  const [autodriveRunning, setAutodriveRunning] = useState(false);
  const [autodriveError, setAutodriveError] = useState('');
  const [availableDemos, setAvailableDemos] = useState([]);
  const [demoMode, setDemoMode] = useState(false);
  const [selectedDemo, setSelectedDemo] = useState('');
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
  const [hasPendingChanges, setHasPendingChanges] = useState(false);
  const [isTypingDemoPrompt, setIsTypingDemoPrompt] = useState(false);
  const typingIntervalRef = useRef(null);

  const cancelDemoTyping = () => {
    if (typingIntervalRef.current) {
      clearInterval(typingIntervalRef.current);
      typingIntervalRef.current = null;
    }
    if (isTypingDemoPrompt) setIsTypingDemoPrompt(false);
  };

  const startTypingDemoPrompt = (text) => {
    cancelDemoTyping();
    const promptText = String(text || '');
    if (!promptText) {
      setUserInput('');
      return;
    }
    setUserInput('');
    setIsTypingDemoPrompt(true);
    let index = 0;
    const totalChars = Math.max(promptText.length, 1);
    const delay = Math.min(50, Math.max(15, Math.floor(1000 / totalChars)));
    typingIntervalRef.current = setInterval(() => {
      index += 1;
      setUserInput(promptText.slice(0, index));
      if (index >= promptText.length) {
        cancelDemoTyping();
      }
    }, delay);
  };

  useEffect(() => () => {
    if (typingIntervalRef.current) {
      clearInterval(typingIntervalRef.current);
      typingIntervalRef.current = null;
    }
  }, []);

  // Debug: track when pending-changes flag flips and what the UI will show
  useEffect(() => {
    const mode = hasPendingChanges ? 'diff-review' : 'markdown-view';
    try {
      // eslint-disable-next-line no-console
      console.info(`[PRD DEBUG] hasPendingChanges=${hasPendingChanges} → UI mode=${mode}`);
    } catch {}
  }, [hasPendingChanges]);

  useEffect(() => {
    if (menuBarRef.current) {
      const rect = menuBarRef.current.getBoundingClientRect();
      setMenuBarRect({ left: rect.left, width: rect.width });
    }
  }, []);

  // Centralized fetch for demos so we can reuse on mount and when toggling demo mode
  const fetchDemos = async () => {
    try {
      const res = await fetch('/api/demos');
      const data = await res.json();
      setAvailableDemos(Array.isArray(data?.demos) ? data.demos : []);
    } catch {
      setAvailableDemos([]);
    }
  };

  // Initial load
  useEffect(() => {
    fetchDemos();
  }, []);

  // When demo mode is turned on, ensure we have the latest demos
  useEffect(() => {
    if (demoMode && availableDemos.length === 0) {
      fetchDemos();
    }
  }, [demoMode]);

  // Auto-select the first demo once the list is available and demo mode is on
  useEffect(() => {
    if (demoMode && !selectedDemo && availableDemos.length > 0) {
      setSelectedDemo(availableDemos[0].name);
    }
  }, [availableDemos, demoMode]);

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

  // Fetch conversation for current session (only once real id exists)
  useEffect(() => {
    if (currentSession && !String(currentSession.id || '').startsWith('tmp-')) {
      fetch(`/api/sessions/${currentSession.id}`)
        .then(res => res.json())
        .then(session => { setConversation(session.conversation || []); setAwaitingConfirm(session.awaitingConfirmation || null); })
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

  const isDemoOnRails = Boolean(currentSession?.demo && currentSession.demo.breakout === false);

  // Core send helper to send arbitrary content
  const sendMessage = async (content) => {
    if (!content.trim() || !currentSession) return null;
    setLoading(true);
    try {
      const res = await fetch('/api/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: content,
          llm: llmProvider,
          sessionId: currentSession.id
        })
      });
      const data = await res.json();
      if (Object.prototype.hasOwnProperty.call(data, 'hasPrdChanges') && data.hasPrdChanges === false && !(data.demo && data.demo.breakout === false)) {
        setInfoMsg('No PRD changes detected.');
        setTimeout(() => setInfoMsg(''), 2000);
      }
      setPrdDiffRefreshKey(k => k + 1);
      const sessionRes = await fetch(`/api/sessions/${currentSession.id}`);
      const sessionData = await sessionRes.json();
      setConversation(sessionData.conversation || []);
      setAwaitingConfirm(sessionData.awaitingConfirmation || null);
      setCurrentSession(sessionData);
      if (data?.demo && data.demo.breakout === false) {
        setHasPendingChanges(false);
        setMarkdownRefreshKey(k => k + 1);
      }
      return data;
    } finally {
      setLoading(false);
    }
  };

  // Send message for current session from input
  const handleSend = async () => {
    cancelDemoTyping();
    const data = await sendMessage(userInput);
    if (data?.demo && data.demo.breakout === false && data.demo.nextPrompt) {
      startTypingDemoPrompt(data.demo.nextPrompt);
    } else {
      setUserInput('');
    }
  };

  const handleInputKeyDown = (e) => {
    if (e.key === 'Enter' && !loading) {
      handleSend();
    }
  };

  // Quick confirm/disagree buttons
  const handleConfirmApply = async () => {
    // Use structured confirm to avoid relying on text matching
    if (!currentSession) return;
    setLoading(true);
    try {
      const res = await fetch('/api/llm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: currentSession.id, confirm: true })
      });
      const data = await res.json();
      // Refresh session state and conversation
      const sessionRes = await fetch(`/api/sessions/${currentSession.id}`);
      const sessionData = await sessionRes.json();
      setConversation(sessionData.conversation || []);
      setAwaitingConfirm(sessionData.awaitingConfirmation || null);
      setCurrentSession(sessionData);
      // If backend flushed a pending draft, reflect that in UI (hasPendingChanges or banners)
      if (data?.flushedPending) {
        setInfoMsg('Pending draft flushed to temp PRD and is available for review.');
        setPrdDiffRefreshKey(k => k + 1);
      }
      if (data?.demo && data.demo.breakout === false && data.demo.nextPrompt) {
        setMarkdownRefreshKey(k => k + 1);
        startTypingDemoPrompt(data.demo.nextPrompt);
      } else {
        cancelDemoTyping();
        setUserInput('');
      }
      return data;
    } finally {
      setLoading(false);
    }
  };
  const handleNeedsChanges = () => {
    const prefill = awaitingConfirm?.summaryText ? `Not quite. ${awaitingConfirm.summaryText}\n\nUpdate: ` : 'Not quite. ';
    cancelDemoTyping();
    setUserInput(prefill);
    const inputEl = document.querySelector('.user-input');
    if (inputEl) setTimeout(() => inputEl.focus(), 0);
  };

  const handleCheckApiKey = async () => {
    setApiCheckLoading(true);
    setApiCheckResult('');
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      if (data.ok) {
        setApiCheckResult(`OK. Model: ${data.openai?.model || 'N/A'}`);
      } else {
        const parts = [];
        if (!data.env?.OPENAI_API_KEY) parts.push('Missing OPENAI_API_KEY');
        if (data.openai && data.openai.ok === false) parts.push(`OpenAI: ${data.openai.error}`);
        if (data.python && data.python.ok === false) parts.push(`Python: ${data.python.error}`);
        setApiCheckResult(`Error: ${parts.join(' | ') || 'Unknown error'}`);
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

  const handleRunAutodrive = async () => {
    if (autodriveRunning) return;
    setAutodriveRunning(true);
    setAutodriveError('');
    // Kick off polling so the sidebar updates while the scenario runs
    const pollId = setInterval(fetchSessions, 2000);
    // Grab the latest list immediately so the newly created session appears
    fetchSessions();
    try {
      const res = await fetch('/api/sessions/autodrive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: 'photo_detector_tests.txt' })
      });
      const raw = await res.text();
      if (!res.ok) {
        throw new Error(raw || `Scenario run failed (${res.status})`);
      }
      let data = null;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch (err) {
        throw new Error(raw || 'Autodrive returned non-JSON response');
      }
      if (data.session) {
        const session = data.session;
        setSessions(prev => {
          const filtered = prev.filter(s => s.id !== session.id);
          const next = [session, ...filtered];
          saveOrder(next.map(s => s.id));
          return applyOrder(next);
        });
        setCurrentSession(session);
        setSidebarOpen(true);
      } else if (data.sessionId) {
        const sessionRes = await fetch(`/api/sessions/${data.sessionId}`);
        if (sessionRes.ok) {
          const session = await sessionRes.json();
          setSessions(prev => {
            const filtered = prev.filter(s => s.id !== session.id);
            const next = [session, ...filtered];
            saveOrder(next.map(s => s.id));
            return applyOrder(next);
          });
          setCurrentSession(session);
          setSidebarOpen(true);
        } else {
          await fetchSessions();
        }
      } else {
        await fetchSessions();
      }
    } catch (err) {
      console.error('Autodrive scenario failed:', err);
      setAutodriveError(err.message || 'Failed to run scenario');
    } finally {
      clearInterval(pollId);
      await fetchSessions();
      setAutodriveRunning(false);
      // Force a visible refresh so the user sees the results immediately
      setTimeout(() => window.location.reload(), 1500);
    }
  };

  // Create new session
  const handleNewSession = async (maybeOptions) => {
    const options = (maybeOptions && typeof maybeOptions === 'object' && !Array.isArray(maybeOptions) && !('nativeEvent' in maybeOptions))
      ? maybeOptions
      : {};
    if (creatingSession) return;
    try {
      setCreatingSession(true);
      // Determine a session title (prompt by default, but reuse demo title when requested)
      let title = undefined;
      if (options.useDemoTitle && demoMode) {
        const selected = availableDemos.find(d => d.name === selectedDemo);
        title = (selected?.title || selected?.name || '').trim();
      } else {
        try { title = prompt('Enter a title for the new session:'); } catch {}
      }
      if (!title || !String(title).trim()) {
        const ts = new Date();
        title = `Session ${ts.getFullYear()}-${String(ts.getMonth()+1).padStart(2,'0')}-${String(ts.getDate()).padStart(2,'0')} ${String(ts.getHours()).padStart(2,'0')}:${String(ts.getMinutes()).padStart(2,'0')}`;
      }
      title = title.trim();

      if (demoMode && !selectedDemo) {
        setErrorMsg('Select a demo before creating a demo session.');
        setCreatingSession(false);
        return;
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
        body: JSON.stringify({ title, demoName: demoMode ? selectedDemo : undefined }),
      });
      if (!res.ok) throw new Error(`Create failed (${res.status})`);
      const { demoNextPrompt, ...serverSession } = await res.json();

      // Replace temp with server session
      setSessions(prev => prev.map(s => s.id === tempId ? serverSession : s));
      setCurrentSession(serverSession);
      if (demoNextPrompt) {
        startTypingDemoPrompt(demoNextPrompt);
      } else {
        cancelDemoTyping();
        setUserInput('');
      }

      // No automatic LLM kickoff; wait for the user's first message
    } catch (err) {
      console.error('New session failed:', err);
      setErrorMsg('Failed to create session. Is the backend running?');
    } finally {
      setCreatingSession(false);
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
  // Run a health check on mount and surface issues prominently
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/health');
        const data = await r.json();
        if (!data.ok) {
          const parts = [];
          if (!data.env?.OPENAI_API_KEY) parts.push('Missing OPENAI_API_KEY');
          if (data.openai && data.openai.ok === false) parts.push(`OpenAI: ${data.openai.error}`);
          if (data.python && data.python.ok === false) parts.push(`Python: ${data.python.error}`);
          setErrorMsg(parts.join(' | ') || 'Health check failed');
        } else {
          setApiCheckResult(`Connected. Model: ${data.activeModel || data.openai?.model || 'N/A'}`);
        }
      } catch (e) {
        setErrorMsg('Health check failed: backend unreachable');
      }
    })();
  }, []);

  // Sidebar UI
  const sidebar = (
    sidebarOpen && (
      <aside className="sidebar">
        <div className="sidebar-block sidebar-block--sessions">
          <div className="sidebar-header">
            <span>Sessions</span>
            <button
              type="button"
              className="new-session-btn"
              onClick={handleNewSession}
              disabled={creatingSession}
              title={creatingSession ? 'Creating session…' : 'New session'}
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
        </div>

        <div className="sidebar-block">
          <div className="sidebar-field">
            <label htmlFor="llm-select" className="sidebar-label">LLM Provider</label>
            <select
              id="llm-select"
              className="sidebar-select"
              value={llmProvider}
              onChange={(e) => setLlmProvider(e.target.value)}
            >
              <option value="gpt5">OpenAI GPT‑5</option>
              <option value="gemini">Google Gemini</option>
            </select>
          </div>
          <button
            className="sidebar-btn"
            onClick={handleCheckApiKey}
            disabled={apiCheckLoading}
          >
            {apiCheckLoading ? 'Checking...' : 'Check API Key'}
          </button>
          {apiCheckResult && (
            <div className="api-check-result sidebar-feedback">{apiCheckResult}</div>
          )}
        </div>

        <div className="sidebar-block">
          <div className="sidebar-toggle-row">
            <input
              id="demo-mode-toggle"
              type="checkbox"
              checked={demoMode}
              onChange={(e) => {
                const checked = e.target.checked;
                setDemoMode(checked);
                if (checked && !selectedDemo && availableDemos.length) {
                  setSelectedDemo(availableDemos[0].name);
                }
              }}
            />
            <label htmlFor="demo-mode-toggle">Demo mode</label>
          </div>
          {demoMode && (
            <>
              <div className="sidebar-field">
                <label htmlFor="demo-select" className="sidebar-label">Demo scenario</label>
                <div className="demo-picker">
                  <select
                    id="demo-select"
                    className="demo-select"
                    value={selectedDemo}
                    onChange={(e) => setSelectedDemo(e.target.value)}
                    onFocus={() => fetchDemos()}
                  >
                    {!selectedDemo && <option value="">Select demo…</option>}
                    {availableDemos.length === 0 && (
                      <option value="" disabled>(No demos found)</option>
                    )}
                    {availableDemos.map(d => (
                      <option key={d.name} value={d.name}>{d.title || d.name}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="sidebar-btn sidebar-btn--compact"
                    title="Refresh list"
                    onClick={async () => {
                      await fetchDemos();
                      if (!selectedDemo && availableDemos.length > 0) {
                        setSelectedDemo(availableDemos[0].name);
                      }
                    }}
                  >Refresh</button>
                </div>
              </div>
              <button
                type="button"
                className="sidebar-btn"
                title="Start selected demo session"
                disabled={!selectedDemo || creatingSession}
                onClick={() => handleNewSession({ useDemoTitle: true })}
              >Start Demo</button>
            </>
          )}
        </div>

        <div className="sidebar-block">
          <button
            className="sidebar-btn"
            onClick={handleRunAutodrive}
            disabled={autodriveRunning}
          >
            {autodriveRunning ? 'Running scenario…' : 'Auto-generate PRD'}
          </button>
          {autodriveError && (
            <div className="api-check-result sidebar-feedback" style={{ color: '#b31d28' }}>{autodriveError}</div>
          )}
        </div>
      </aside>
    )
  );

  // Top menu bar with menu button
  const topMenu = (
    <div className="menu-bar">
      <span className="menu-icon" onClick={handleSidebarOpen} style={{cursor: 'pointer', fontSize: '1.7rem'}}>&#9776;</span>
  <span className="menu-title">Requirements Builder</span>
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
                {expandedPanel === 'code' ? (
                  <div style={{ padding: 12 }}>
                    {currentSession && !String(currentSession.id || '').startsWith('tmp-') ? (
                      <CodePreview sessionId={currentSession.id} onClose={() => setExpandedPanel(null)} />
                    ) : (
                      <div style={{ color: '#b31d28' }}>Create or select a session first.</div>
                    )}
                  </div>
                ) : (
                  <div style={{ padding: 12 }}>Expanded panel content goes here</div>
                )}
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
                  {infoMsg && (
                    <div style={{ color: '#2563eb', whiteSpace: 'pre-wrap', marginBottom: 8 }}>
                      {infoMsg}
                    </div>
                  )}
                  {conversation.length === 0 && !loading && 'LLM Replies go here'}
                  {conversation.map((msg, idx) => {
                    const rawContent = msg?.content;
                    const body = typeof rawContent === 'string'
                      ? rawContent
                      : rawContent == null
                        ? ''
                        : (() => {
                            try {
                              if (Array.isArray(rawContent)) {
                                return rawContent.map(piece => {
                                  if (typeof piece === 'string') return piece;
                                  if (piece && typeof piece.text === 'string') return piece.text;
                                  return JSON.stringify(piece);
                                }).join('\n');
                              }
                              if (typeof rawContent === 'object') {
                                return JSON.stringify(rawContent, null, 2);
                              }
                              return String(rawContent);
                            } catch {
                              return String(rawContent);
                            }
                          })();
                    return (
                      <div
                        key={idx}
                        className={`chat-msg ${msg.role === 'user' ? 'chat-msg--user' : 'chat-msg--assistant'}`}
                      >
                        <div className="chat-msg__header">{msg.role === 'user' ? 'You' : 'LLM'}</div>
                      <ReactMarkdown
                        components={{
                          p: (props) => <p className="chat-msg__p" {...props} />,
                          ul: (props) => <ul className="chat-msg__ul" {...props} />,
                          ol: (props) => <ol className="chat-msg__ol" {...props} />,
                          li: (props) => <li className="chat-msg__li" {...props} />,
                          code: (props) => <code className="chat-msg__code" {...props} />
                        }}
                      >
                        {body}
                      </ReactMarkdown>
                      </div>
                    );
                  })}
                  {awaitingConfirm && (
                    <div className="confirm-bar">
                      <div className="confirm-bar__text">{awaitingConfirm.summaryText}</div>
                      <div className="confirm-bar__actions">
                        <button className="confirm-btn confirm-btn--accept" onClick={handleConfirmApply}>Looks right</button>
                        <button className="confirm-btn confirm-btn--reject" onClick={handleNeedsChanges}>Needs changes</button>
                      </div>
                    </div>
                  )}
                  {loading && <div>Loading...</div>}
                </div>
              </section>
              <div className="markdown-panel">
                <div className="markdown-panel-content">
                  {/* Single-display rule: show either review (diff) or the main Markdown */}
                  {currentSession && !String(currentSession.id || '').startsWith('tmp-') && hasPendingChanges && !isDemoOnRails ? (
                    <PrdDiffPanel
                      sessionId={currentSession.id}
                      refreshKey={prdDiffRefreshKey}
                      onSave={handlePrdSave}
                      onDiffStateChange={setHasPendingChanges}
                    />
                  ) : (
                    <>
                      {currentSession && !String(currentSession.id || '').startsWith('tmp-') && !isDemoOnRails && (
                        <div style={{ display: 'none' }}>
                          <PrdDiffPanel
                            sessionId={currentSession.id}
                            refreshKey={prdDiffRefreshKey}
                            onSave={handlePrdSave}
                            onDiffStateChange={setHasPendingChanges}
                          />
                        </div>
                      )}
                      {isDemoOnRails && (
                        <div className="demo-hint">Demo snapshot applied automatically.</div>
                      )}
                      <MarkdownPanel
                        sessionId={currentSession && !String(currentSession.id || '').startsWith('tmp-') ? currentSession.id : null}
                        onSave={handlePrdSave}
                        refreshKey={markdownRefreshKey}
                      />
                    </>
                  )}
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
              onChange={e => {
                if (isTypingDemoPrompt) cancelDemoTyping();
                setUserInput(e.target.value);
              }}
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
