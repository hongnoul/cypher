import { FormEvent, useEffect, useState } from 'react';
import logo from '@/assets/logo.svg';
import './App.css';

type ImportForm = {
  walletLabel: string;
  mnemonic: string;
  password: string;
  restoreHeight: string;
};

type CreateForm = {
  walletLabel: string;
  password: string;
};

type BalanceResponse = {
  ok: boolean;
  walletId: string;
  network: 'stagenet' | 'mainnet';
  balanceAtomic: string;
  unlockedAtomic: string;
  syncedHeight: number;
  lastUpdatedAt: string;
  source: string;
};

type Tx = {
  txid: string;
  direction: 'in' | 'out';
  amountAtomic: string;
  feeAtomic: string;
  confirmations: number;
  timestamp: string;
  status: 'pending' | 'confirmed';
};

type ViewMode = 'start' | 'import' | 'create' | 'unlock' | 'dashboard';

type PasswordVerifier = {
  version: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  hash: string;
  createdAt: string;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function normalizeMnemonic(input: string) {
  return input.trim().toLowerCase().replace(/\s+/g, ' ');
}

function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(b64: string) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function deriveAesKey(password: string, salt: ArrayBuffer) {
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 120_000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function derivePasswordHash(password: string, salt: Uint8Array, iterations = 120_000) {
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

async function extensionSet(items: Record<string, unknown>) {
  const extChrome = (globalThis as unknown as { chrome?: any }).chrome;
  if (extChrome?.storage?.local) {
    await extChrome.storage.local.set(items);
  }
  for (const [k, v] of Object.entries(items)) {
    localStorage.setItem(k, JSON.stringify(v));
  }
}

async function extensionGet<T = any>(key: string): Promise<T | null> {
  const extChrome = (globalThis as unknown as { chrome?: any }).chrome;
  if (extChrome?.storage?.local) {
    const result = await extChrome.storage.local.get(key);
    if (result?.[key] != null) return result[key] as T;
  }

  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return raw as T;
  }
}

async function saveEncryptedPayload(key: string, value: string, password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await deriveAesKey(password, salt.buffer);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(value));

  const payload = {
    version: 1,
    algorithm: 'AES-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations: 120_000,
    salt: toBase64(salt),
    iv: toBase64(iv),
    cipherText: toBase64(new Uint8Array(cipher)),
    createdAt: new Date().toISOString(),
  };

  await extensionSet({ [key]: payload });
}

async function savePasswordVerifier(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePasswordHash(password, salt, 120_000);

  const verifier: PasswordVerifier = {
    version: 1,
    kdf: 'PBKDF2-SHA256',
    iterations: 120_000,
    salt: toBase64(salt),
    hash: toBase64(hash),
    createdAt: new Date().toISOString(),
  };

  await extensionSet({ cypher_password_verifier: verifier });
}

async function verifyPassword(password: string) {
  const verifier = await extensionGet<PasswordVerifier>('cypher_password_verifier');
  if (!verifier) return false;

  const salt = fromBase64(verifier.salt);
  const computed = await derivePasswordHash(password, salt, verifier.iterations);
  return toBase64(computed) === verifier.hash;
}

function fromAtomicToXmr(atomic: string) {
  const n = Number(atomic) / 1_000_000_000_000;
  return Number.isFinite(n) ? n.toFixed(6) : '0.000000';
}

function shortId(id?: string) {
  if (!id) return '-';
  return `${id.slice(0, 6)}...${id.slice(-4)}`;
}

async function persistWalletId(id: string) {
  await extensionSet({ cypher_wallet_id: id });
}

async function clearSession() {
  localStorage.removeItem('cypher_session_unlocked');
}

function App() {
  const [view, setView] = useState<ViewMode>('start');
  const [walletId, setWalletId] = useState<string | null>(null);
  const [balance, setBalance] = useState<BalanceResponse | null>(null);
  const [txs, setTxs] = useState<Tx[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [unlockPassword, setUnlockPassword] = useState('');

  const [importForm, setImportForm] = useState<ImportForm>({
    walletLabel: 'Primary Wallet',
    mnemonic: '',
    password: '',
    restoreHeight: '0',
  });

  const [createForm, setCreateForm] = useState<CreateForm>({
    walletLabel: 'Primary Wallet',
    password: '',
  });

  useEffect(() => {
    (async () => {
      const id = await extensionGet<string>('cypher_wallet_id');
      if (id) {
        setWalletId(id);
        setView('unlock');
      }
    })();
  }, []);

  const refreshData = async (idOverride?: string) => {
    const id = idOverride ?? walletId;
    if (!id) {
      setStatus('No wallet connected yet.');
      return;
    }

    setBusy(true);
    setStatus('Refreshing...');

    try {
      const [balanceRes, txRes] = await Promise.all([
        fetch(`http://localhost:8787/wallets/${id}/balance`),
        fetch(`http://localhost:8787/wallets/${id}/txs?limit=6`),
      ]);

      const balanceJson = await balanceRes.json();
      const txJson = await txRes.json();

      if (!balanceJson?.ok) throw new Error(balanceJson?.message || 'Balance fetch failed.');

      setBalance(balanceJson);
      setTxs(txJson?.txs ?? []);
      setStatus('Updated.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Refresh failed.');
    } finally {
      setBusy(false);
    }
  };

  const submitImport = async (e: FormEvent) => {
    e.preventDefault();
    const normalized = normalizeMnemonic(importForm.mnemonic);
    const words = normalized.split(' ').filter(Boolean);

    if (words.length !== 25) {
      setStatus(`Expected 25 words, got ${words.length}.`);
      return;
    }
    if (importForm.password.length < 8) {
      setStatus('Password must be at least 8 chars.');
      return;
    }

    setBusy(true);
    setStatus('Importing wallet...');

    try {
      await saveEncryptedPayload('cypher_encrypted_mnemonic', normalized, importForm.password);
      await savePasswordVerifier(importForm.password);

      const res = await fetch('http://localhost:8787/wallets/register-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletLabel: importForm.walletLabel.trim() || 'Primary Wallet',
          restoreHeight: Number(importForm.restoreHeight || '0'),
        }),
      });

      const data = await res.json();
      const id = data?.walletId ?? data?.response?.walletId;
      if (!id) throw new Error('No walletId returned from backend.');

      await persistWalletId(id);
      setWalletId(id);
      setView('dashboard');
      setUnlockPassword('');
      await refreshData(id);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  };

  const submitCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (createForm.password.length < 8) {
      setStatus('Password must be at least 8 chars.');
      return;
    }

    setBusy(true);
    setStatus('Create wallet flow is scaffolded. Wiring mnemonic generation next.');

    try {
      const res = await fetch('http://localhost:8787/wallets/register-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletLabel: createForm.walletLabel.trim() || 'Primary Wallet',
          restoreHeight: 0,
        }),
      });
      const data = await res.json();
      const id = data?.walletId;
      if (!id) throw new Error('No walletId returned from backend.');

      await saveEncryptedPayload('cypher_encrypted_seed_placeholder', 'PENDING_GENERATED_MNEMONIC', createForm.password);
      await savePasswordVerifier(createForm.password);
      await persistWalletId(id);

      setWalletId(id);
      setView('dashboard');
      setUnlockPassword('');
      await refreshData(id);
      setStatus('Wallet shell created. Next: real mnemonic generation.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Create flow failed.');
    } finally {
      setBusy(false);
    }
  };

  const submitUnlock = async (e: FormEvent) => {
    e.preventDefault();
    if (!unlockPassword) {
      setStatus('Enter password to unlock.');
      return;
    }

    setBusy(true);
    try {
      const ok = await verifyPassword(unlockPassword);
      if (!ok) {
        setStatus('Incorrect password.');
        return;
      }

      setView('dashboard');
      setStatus('Unlocked.');
      await refreshData();
      setUnlockPassword('');
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await clearSession();
    setView('unlock');
    setStatus('');
    setBalance(null);
    setTxs([]);
  };

  const resetWallet = async () => {
    setBusy(true);
    try {
      const extChrome = (globalThis as unknown as { chrome?: any }).chrome;
      if (extChrome?.storage?.local) {
        await extChrome.storage.local.clear();
      }
      localStorage.clear();

      setWalletId(null);
      setBalance(null);
      setTxs([]);
      setUnlockPassword('');
      setImportForm({ walletLabel: 'Primary Wallet', mnemonic: '', password: '', restoreHeight: '0' });
      setCreateForm({ walletLabel: 'Primary Wallet', password: '' });
      setView('start');
      setStatus('Wallet reset complete. Create or import a wallet to continue.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Reset failed.');
    } finally {
      setBusy(false);
    }
  };

  const StartScreen = (
    <section style={{ marginTop: 18, display: 'grid', gap: 10 }}>
      <div
        style={{
          background: '#000000',
          border: '1px solid #000000',
          borderRadius: 14,
          padding: 12,
          fontSize: 13,
          opacity: 0.9,
        }}
      >
        Fast mode: connect quickly, refine infrastructure later.
      </div>

      <button
        onClick={() => setView('create')}
        style={{
          border: 0,
          background: '#f8d7da',
          color: 'white',
          borderRadius: 12,
          padding: '12px 14px',
          cursor: 'pointer',
          fontWeight: 700,
        }}
      >
        Create New Wallet
      </button>

      <button
        onClick={() => setView('import')}
        style={{
          border: '1px solid #000000',
          background: '#000000',
          color: '#e7f5ff',
          borderRadius: 12,
          padding: '12px 14px',
          cursor: 'pointer',
          fontWeight: 700,
        }}
      >
        Import from Mnemonic
      </button>
    </section>
  );

  const UnlockScreen = (
    <section style={{ marginTop: 14, background: '#000000', border: '1px solid #000000', borderRadius: 12, padding: 10 }}>
      <form onSubmit={submitUnlock} style={{ display: 'grid', gap: 8 }}>
        <div style={{ fontSize: 13, opacity: 0.85 }}>Enter local password to unlock wallet</div>
        <input
          type="password"
          placeholder="Password"
          value={unlockPassword}
          onChange={(e) => setUnlockPassword(e.target.value)}
          style={{ background: '#000000', color: '#e7f5ff', border: '1px solid #000000', borderRadius: 8, padding: 8 }}
        />
        <button
          type="submit"
          disabled={busy}
          style={{ border: 0, borderRadius: 8, padding: 10, background: '#f8d7da', color: 'white', fontWeight: 700, cursor: 'pointer' }}
        >
          Unlock
        </button>
        <button
          type="button"
          onClick={resetWallet}
          disabled={busy}
          style={{
            border: '1px solid #000000',
            background: '#000000',
            color: '#f8d7da',
            borderRadius: 8,
            padding: 10,
            cursor: 'pointer',
            fontWeight: 700,
            opacity: busy ? 0.7 : 1,
          }}
        >
          Forgot password?
        </button>
      </form>
    </section>
  );

  const ImportScreen = (
    <section style={{ marginTop: 14, background: '#000000', border: '1px solid #000000', borderRadius: 12, padding: 10 }}>
      <form onSubmit={submitImport} style={{ display: 'grid', gap: 8 }}>
        <input
          placeholder="Wallet label"
          value={importForm.walletLabel}
          onChange={(e) => setImportForm((p) => ({ ...p, walletLabel: e.target.value }))}
          style={{ background: '#000000', color: '#e7f5ff', border: '1px solid #000000', borderRadius: 8, padding: 8 }}
        />
        <textarea
          rows={4}
          placeholder="25-word mnemonic"
          value={importForm.mnemonic}
          onChange={(e) => setImportForm((p) => ({ ...p, mnemonic: e.target.value }))}
          style={{ background: '#000000', color: '#e7f5ff', border: '1px solid #000000', borderRadius: 8, padding: 8 }}
        />
        <input
          type="password"
          placeholder="Local encryption password"
          value={importForm.password}
          onChange={(e) => setImportForm((p) => ({ ...p, password: e.target.value }))}
          style={{ background: '#000000', color: '#e7f5ff', border: '1px solid #000000', borderRadius: 8, padding: 8 }}
        />
        <input
          type="number"
          min={0}
          placeholder="Restore height"
          value={importForm.restoreHeight}
          onChange={(e) => setImportForm((p) => ({ ...p, restoreHeight: e.target.value }))}
          style={{ background: '#000000', color: '#e7f5ff', border: '1px solid #000000', borderRadius: 8, padding: 8 }}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => setView('start')} style={{ flex: 1, border: '1px solid #000000', background: '#000000', color: '#e7f5ff', borderRadius: 8, padding: 10, cursor: 'pointer' }}>
            Back
          </button>
          <button type="submit" disabled={busy} style={{ flex: 1, border: 0, borderRadius: 8, padding: 10, background: '#f8d7da', color: '#000000', fontWeight: 700, cursor: 'pointer' }}>
            Import
          </button>
        </div>
      </form>
    </section>
  );

  const CreateScreen = (
    <section style={{ marginTop: 14, background: '#000000', border: '1px solid #000000', borderRadius: 12, padding: 10 }}>
      <form onSubmit={submitCreate} style={{ display: 'grid', gap: 8 }}>
        <input
          placeholder="Wallet label"
          value={createForm.walletLabel}
          onChange={(e) => setCreateForm((p) => ({ ...p, walletLabel: e.target.value }))}
          style={{ background: '#000000', color: '#e7f5ff', border: '1px solid #000000', borderRadius: 8, padding: 8 }}
        />
        <input
          type="password"
          placeholder="Set local encryption password"
          value={createForm.password}
          onChange={(e) => setCreateForm((p) => ({ ...p, password: e.target.value }))}
          style={{ background: '#000000', color: '#e7f5ff', border: '1px solid #000000', borderRadius: 8, padding: 8 }}
        />
        <div style={{ fontSize: 12, opacity: 0.75 }}>
          Next step: generate mnemonic locally and show backup confirmation.
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => setView('start')} style={{ flex: 1, border: '1px solid #000000', background: '#000000', color: '#e7f5ff', borderRadius: 8, padding: 10, cursor: 'pointer' }}>
            Back
          </button>
          <button type="submit" disabled={busy} style={{ flex: 1, border: 0, borderRadius: 8, padding: 10, background: '#f8d7da', color: 'white', fontWeight: 700, cursor: 'pointer' }}>
            Create
          </button>
        </div>
      </form>
    </section>
  );

  const Dashboard = (
    <>
      <section
        style={{
          marginTop: 12,
          background: 'linear-gradient(135deg, #000000, #000000)',
          border: '1px solid #000000',
          borderRadius: 14,
          padding: 12,
        }}
      >
        <div style={{ fontSize: 12, opacity: 0.75 }}>Wallet ID</div>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>{shortId(walletId || undefined)}</div>

        <div style={{ fontSize: 12, opacity: 0.75 }}>Total Balance</div>
        <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1.1 }}>
          {balance ? fromAtomicToXmr(balance.balanceAtomic) : '0.000000'} XMR
        </div>

        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
          Unlocked: {balance ? fromAtomicToXmr(balance.unlockedAtomic) : '0.000000'} XMR
        </div>
      </section>

      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button
          onClick={() => refreshData()}
          disabled={busy}
          style={{
            flex: 1,
            border: 0,
            background: '#f8d7da',
            color: 'white',
            borderRadius: 10,
            padding: '10px 12px',
            cursor: 'pointer',
            fontWeight: 600,
            opacity: busy ? 0.7 : 1,
          }}
        >
          {busy ? 'Working...' : 'Refresh'}
        </button>
        <button
          onClick={logout}
          style={{
            border: '1px solid #000000',
            background: '#000000',
            color: '#e7f5ff',
            borderRadius: 10,
            padding: '10px 12px',
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          Logout
        </button>
      </div>

      <section style={{ marginTop: 10 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Recent Activity</div>
        <div style={{ display: 'grid', gap: 8 }}>
          {txs.length === 0 && (
            <div style={{ background: '#000000', border: '1px solid #000000', borderRadius: 10, padding: 10, fontSize: 13, opacity: 0.75 }}>
              No transactions yet.
            </div>
          )}
          {txs.map((tx) => (
            <div key={tx.txid} style={{ background: '#000000', border: '1px solid #000000', borderRadius: 10, padding: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span style={{ color: tx.direction === 'in' ? '#f8d7da' : '#f8d7da', fontWeight: 700 }}>
                  {tx.direction === 'in' ? 'Received' : 'Sent'}
                </span>
                <span>{fromAtomicToXmr(tx.amountAtomic)} XMR</span>
              </div>
              <div style={{ fontSize: 11, opacity: 0.65, marginTop: 4 }}>
                {new Date(tx.timestamp).toLocaleString()} • {tx.confirmations} conf • {tx.status}
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  );

  return (
    <main
      style={{
        width: 360,
        minHeight: view === 'unlock' ? 0 : 520,
        background: '#000000',
        color: '#e7f5ff',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace',
        display: 'inline-block',
      }}
    >
      <div style={{ padding: '12px 14px' }}>
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <img src={logo} alt="Cypher logo" style={{ height: 34, width: 'auto', display: 'block' }} />
        </header>

        {view === 'start' && StartScreen}
        {view === 'import' && ImportScreen}
        {view === 'create' && CreateScreen}
        {view === 'unlock' && UnlockScreen}
        {view === 'dashboard' && Dashboard}

        {status ? (
          <footer style={{ marginTop: 10, fontSize: 11, opacity: 0.7, borderTop: '1px solid #000000', paddingTop: 8 }}>
            {status}
          </footer>
        ) : null}
      </div>
    </main>
  );
}

export default App;
