import { render } from 'preact';
import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { SessionList } from './components/SessionList.js';
import { SessionView } from './components/SessionView.js';
import { DecisionReview } from './components/DecisionReview.js';
import { EventLog } from './components/EventLog.js';
import { AgentStatus } from './components/AgentStatus.js';
import { LoginPage } from './components/LoginPage.js';
import type { Session, Decision, IncomingEvent, AgentStatus as AgentStatusType } from '../shared/types.js';
import type { WsEvent } from '../shared/events.js';

type View = 'sessions' | 'session' | 'decisions' | 'events' | 'agents';
type AuthState = 'checking' | 'login' | 'authenticated';

function App() {
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [view, setView] = useState<View>('sessions');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [events, setEvents] = useState<IncomingEvent[]>([]);
  const [agents, setAgents] = useState<AgentStatusType[]>([]);
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0);

  // ── Auth check ──
  useEffect(() => {
    fetch('/auth/check')
      .then((res) => {
        if (res.ok) {
          setAuthState('authenticated');
        } else if (res.status === 401) {
          setAuthState('login');
        } else {
          // No auth configured (404) — proceed without login
          setAuthState('authenticated');
        }
      })
      .catch(() => {
        // Network error or no auth endpoint — proceed without login
        setAuthState('authenticated');
      });
  }, []);

  // Fetch initial data
  const fetchSessions = useCallback(async () => {
    const res = await fetch('/api/sessions');
    if (res.ok) setSessions(await res.json());
  }, []);

  const fetchDecisions = useCallback(async () => {
    const res = await fetch('/api/decisions');
    if (res.ok) setDecisions(await res.json());
  }, []);

  const fetchEvents = useCallback(async () => {
    const res = await fetch('/api/events');
    if (res.ok) setEvents(await res.json());
  }, []);

  const fetchAgents = useCallback(async () => {
    const res = await fetch('/api/agents');
    if (res.ok) setAgents(await res.json());
  }, []);

  useEffect(() => {
    if (authState !== 'authenticated') return;
    fetchSessions();
    fetchDecisions();
    fetchEvents();
    fetchAgents();
  }, [authState, fetchSessions, fetchDecisions, fetchEvents, fetchAgents]);

  // WebSocket connection (only when authenticated)
  useEffect(() => {
    if (authState !== 'authenticated') return;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      if (disposed) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${location.host}/ws`;
      const socket = new WebSocket(wsUrl);
      wsRef.current = socket;

      socket.onopen = () => {
        console.log('[WS] Connected');
        setWsConnected(true);
      };

      socket.onmessage = (e) => {
        const event: WsEvent = JSON.parse(e.data);
        switch (event.type) {
          case 'session:created':
            setSessions((prev) => [event.session, ...prev]);
            break;
          case 'session:phase_changed':
            setSessions((prev) =>
              prev.map((s) => s.id === event.sessionId ? { ...s, phase: event.phase as Session['phase'] } : s),
            );
            setSessionRefreshKey((k) => k + 1);
            break;
          case 'message:new':
            setSessionRefreshKey((k) => k + 1);
            break;
          case 'vote:cast':
            setSessionRefreshKey((k) => k + 1);
            break;
          case 'decision:pending_review':
            setDecisions((prev) => [event.decision, ...prev]);
            setSessionRefreshKey((k) => k + 1);
            break;
          case 'event:received':
            setEvents((prev) => [event.event, ...prev].slice(0, 50));
            break;
          case 'agent:connected':
            setAgents((prev) => prev.map((a) => a.id === event.agentId ? { ...a, connected: true } : a));
            break;
          case 'agent:disconnected':
            setAgents((prev) => prev.map((a) => a.id === event.agentId ? { ...a, connected: false } : a));
            break;
        }
      };

      socket.onclose = () => {
        setWsConnected(false);
        if (!disposed) {
          console.log('[WS] Disconnected, reconnecting in 3s...');
          reconnectTimer = setTimeout(connect, 3000);
        }
      };
    }

    connect();
    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [authState]);

  const navItems: { key: View; label: string; count?: number }[] = [
    { key: 'sessions', label: 'Sessions', count: sessions.length },
    { key: 'decisions', label: 'Decisions', count: decisions.length },
    { key: 'events', label: 'Events', count: events.length },
    { key: 'agents', label: 'Agents', count: agents.length },
  ];

  if (authState === 'checking') {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: 'var(--text-dim)' }}>Loading...</div>;
  }

  if (authState === 'login') {
    return <LoginPage onLogin={() => setAuthState('authenticated')} />;
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      {/* Sidebar */}
      <nav style={{
        width: 220,
        background: 'var(--surface)',
        borderRight: '1px solid var(--border)',
        padding: '20px 0',
        flexShrink: 0,
      }}>
        <div style={{ padding: '0 20px 20px', borderBottom: '1px solid var(--border)' }}>
          <h1 style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)' }}>Council</h1>
          <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>Multi-Agent Orchestrator</p>
        </div>
        <div style={{ padding: '12px 8px' }}>
          {navItems.map((item) => (
            <button
              key={item.key}
              onClick={() => { setView(item.key); setSelectedSessionId(null); }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                width: '100%',
                padding: '8px 12px',
                border: 'none',
                borderRadius: 'var(--radius)',
                background: view === item.key ? 'var(--surface-2)' : 'transparent',
                color: view === item.key ? 'var(--text)' : 'var(--text-dim)',
                cursor: 'pointer',
                fontSize: 14,
                marginBottom: 2,
                textAlign: 'left',
              }}
            >
              {item.label}
              {item.count !== undefined && (
                <span style={{
                  fontSize: 11,
                  background: 'var(--surface-2)',
                  padding: '1px 6px',
                  borderRadius: 10,
                  color: 'var(--text-dim)',
                }}>
                  {item.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </nav>

      {/* Main content */}
      <main style={{ flex: 1, padding: 24, overflow: 'auto' }}>
        {view === 'sessions' && !selectedSessionId && (
          <SessionList
            sessions={sessions}
            onSelect={(id) => { setSelectedSessionId(id); setView('sessions'); }}
          />
        )}
        {view === 'sessions' && selectedSessionId && (
          <SessionView
            sessionId={selectedSessionId}
            refreshKey={sessionRefreshKey}
            onBack={() => setSelectedSessionId(null)}
          />
        )}
        {view === 'decisions' && (
          <DecisionReview decisions={decisions} onReviewSubmitted={fetchDecisions} />
        )}
        {view === 'events' && <EventLog events={events} />}
        {view === 'agents' && <AgentStatus agents={agents} />}
      </main>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
