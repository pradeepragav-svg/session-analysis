import { useState } from 'react';
import type { LoadedSession, SessionConfig } from './types';
import { loadSession } from './services/api';
import { SessionViewer } from './components/SessionViewer';
import './App.css';

const DEFAULT_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function App() {
  const [entId, setEntId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [cookie, setCookie] = useState('');
  const [timezone, setTimezone] = useState(DEFAULT_TZ);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<LoadedSession | null>(null);

  async function handleLoad(e: React.FormEvent) {
    e.preventDefault();
    if (!entId.trim() || !sessionId.trim() || !cookie.trim()) {
      setError('entId, sessionId and cookie are required.');
      return;
    }
    setError(null);
    setLoading(true);
    setProgress(null);
    setSession(null);

    const config: SessionConfig = {
      entId: entId.trim(),
      sessionId: sessionId.trim(),
      cookie: cookie.trim(),
      timezone,
    };

    try {
      const { rrwebEvents, whatfixEvents, indexEntries } = await loadSession(
        config,
        (loaded, total) => setProgress({ loaded, total })
      );

      const timestamps = indexEntries.map((e) => e.timestamp);
      const startTs = Math.min(...timestamps);
      const endTs = Math.max(...timestamps);

      setSession({ config, rrwebEvents, whatfixEvents, indexEntries, startTs, endTs });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Session Replay Viewer</h1>
      </header>

      <form className="config-form" onSubmit={handleLoad}>
        <div className="form-row">
          <label>
            Enterprise ID
            <input
              value={entId}
              onChange={(e) => setEntId(e.target.value)}
              placeholder="d96d0adf-4b0d-4458-9c13-9146ec6a35f1"
              spellCheck={false}
            />
          </label>
          <label>
            Session ID
            <input
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              placeholder="d942fe61-ed25-80b1-21aa-4f308b1dd0af"
              spellCheck={false}
            />
          </label>
          <label>
            Timezone
            <input
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="America/New_York"
            />
          </label>
        </div>
        <label className="cookie-label">
          Session Cookie
          <textarea
            value={cookie}
            onChange={(e) => setCookie(e.target.value)}
            placeholder="Paste the full cookie string from the network request (sid=...; eid=...; ...)"
            rows={3}
            spellCheck={false}
          />
        </label>
        <button type="submit" disabled={loading}>
          {loading
            ? progress
              ? `Loading chunk ${progress.loaded}/${progress.total}…`
              : 'Loading…'
            : 'Load Session'}
        </button>
      </form>

      {error && <div className="error-banner">{error}</div>}

      {session && <SessionViewer session={session} />}
    </div>
  );
}

export default App;
