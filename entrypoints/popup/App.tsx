import { useState } from 'react';
import './App.css';

function App() {
  const [status, setStatus] = useState('Not tested');

  const testApi = async () => {
    setStatus('Calling API...');
    try {
      const res = await fetch('http://localhost:8787/health');
      const data = await res.json();
      setStatus(JSON.stringify(data, null, 2));
    } catch (error) {
      setStatus(`API call failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  return (
    <main style={{ minWidth: 320, padding: 16, fontFamily: 'Arial, sans-serif' }}>
      <h2 style={{ marginTop: 0 }}>Cypher API Smoke Test</h2>
      <button onClick={testApi} style={{ padding: '8px 12px', cursor: 'pointer' }}>
        Test API
      </button>
      <pre
        style={{
          marginTop: 12,
          background: '#111827',
          color: '#e5e7eb',
          padding: 10,
          borderRadius: 6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {status}
      </pre>
    </main>
  );
}

export default App;
