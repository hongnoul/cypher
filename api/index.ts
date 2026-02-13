import { Hono } from "hono";
import { z } from "zod";

const app = new Hono();

const importWalletSchema = z.object({
  address: z.string().min(20, "address looks too short"),
  viewKey: z.string().min(20, "view key looks too short"),
  restoreHeight: z.number().int().nonnegative().optional(),
});

const registerLocalWalletSchema = z.object({
  walletLabel: z.string().min(1).max(100),
  restoreHeight: z.number().int().nonnegative().optional(),
});

type WalletRecord = {
  id: string;
  address: string;
  viewKey: string;
  restoreHeight: number;
  createdAt: string;
};

type WalletBalance = {
  network: "stagenet" | "mainnet";
  balanceAtomic: string;
  unlockedAtomic: string;
  syncedHeight: number;
  lastUpdatedAt: string;
};

type WalletTx = {
  txid: string;
  direction: "in" | "out";
  amountAtomic: string;
  feeAtomic: string;
  height: number;
  confirmations: number;
  timestamp: string;
  status: "pending" | "confirmed";
};

type ChainProvider = {
  name: string;
  getBalance(wallet: WalletRecord): Promise<WalletBalance>;
  getTransactions(wallet: WalletRecord, limit?: number): Promise<WalletTx[]>;
};

const wallets = new Map<string, WalletRecord>();

const nowUnix = () => Math.floor(Date.now() / 1000);

function pseudoHash(input: string) {
  // cheap deterministic hash for repeatable mock data
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0);
}

function formatAtomic(n: number) {
  // Monero atomic units string
  return String(Math.max(0, Math.floor(n)));
}

class MockChainProvider implements ChainProvider {
  name = "mock";

  async getBalance(wallet: WalletRecord): Promise<WalletBalance> {
    const seed = pseudoHash(wallet.id + wallet.address + wallet.createdAt);
    const syncedHeight = Math.max(wallet.restoreHeight, 2_850_000 + (seed % 10_000));

    // deterministic mock amounts in atomic units
    const unlockedAtomic = 1_500_000_000_000 + (seed % 900_000_000_000); // ~1.5 to ~2.4 XMR
    const pendingAtomic = seed % 2 === 0 ? 80_000_000_000 : 0; // maybe pending ~0.08 XMR
    const balanceAtomic = unlockedAtomic + pendingAtomic;

    return {
      network: "stagenet",
      balanceAtomic: formatAtomic(balanceAtomic),
      unlockedAtomic: formatAtomic(unlockedAtomic),
      syncedHeight,
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  async getTransactions(wallet: WalletRecord, limit = 10): Promise<WalletTx[]> {
    const seed = pseudoHash(wallet.id + wallet.address + "txs");
    const baseHeight = Math.max(wallet.restoreHeight, 2_850_000 + (seed % 5_000));
    const tipHeight = baseHeight + 120;

    const count = Math.min(Math.max(limit, 1), 50);
    const txs: WalletTx[] = [];

    for (let i = 0; i < count; i++) {
      const txSeed = pseudoHash(`${wallet.id}:${i}:${seed}`);
      const direction: "in" | "out" = i % 3 === 0 ? "out" : "in";
      const height = tipHeight - i * (1 + (txSeed % 7));
      const confirmations = Math.max(0, tipHeight - height);
      const status: "pending" | "confirmed" = confirmations < 10 ? "pending" : "confirmed";

      const amountAtomic =
        direction === "in"
          ? 50_000_000_000 + (txSeed % 250_000_000_000)
          : 20_000_000_000 + (txSeed % 120_000_000_000);

      const feeAtomic = direction === "out" ? 1_500_000 + (txSeed % 900_000) : 0;

      const timestamp = new Date((nowUnix() - (i + 1) * (4 + (txSeed % 8)) * 3600) * 1000).toISOString();

      txs.push({
        txid: `mock_${wallet.id.slice(0, 6)}_${i}_${txSeed.toString(16)}`,
        direction,
        amountAtomic: formatAtomic(amountAtomic),
        feeAtomic: formatAtomic(feeAtomic),
        height,
        confirmations,
        timestamp,
        status,
      });
    }

    return txs;
  }
}

class RealMoneroProvider implements ChainProvider {
  name = "real-daemon-v0";

  private daemonUrl = process.env.MONERO_DAEMON_URL ?? "http://127.0.0.1:38081";

  private async daemonRpc<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(`${this.daemonUrl}/json_rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "0",
        method,
        params,
      }),
    });

    if (!response.ok) {
      throw new Error(`Daemon RPC HTTP ${response.status}`);
    }

    const payload = (await response.json()) as { result?: T; error?: { message?: string } };

    if (payload.error) {
      throw new Error(payload.error.message ?? "Daemon RPC error");
    }

    if (!payload.result) {
      throw new Error("Daemon RPC returned no result");
    }

    return payload.result;
  }

  async getBalance(_wallet: WalletRecord): Promise<WalletBalance> {
    // NOTE: Daemon RPC alone cannot compute wallet balance from mnemonic/address.
    // This minimal implementation proves daemon connectivity and sync height.
    const info = await this.daemonRpc<{ height?: number }>("get_info");
    const syncedHeight = Number(info.height ?? 0);

    return {
      network: "stagenet",
      balanceAtomic: "0",
      unlockedAtomic: "0",
      syncedHeight,
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  async getTransactions(_wallet: WalletRecord, _limit = 10): Promise<WalletTx[]> {
    // Placeholder until wallet-scanning layer is integrated.
    await this.daemonRpc<{ height?: number }>("get_info");
    return [];
  }
}

function resolveProvider(): ChainProvider {
  const mode = (process.env.CHAIN_PROVIDER ?? "mock").toLowerCase();

  if (mode === "real") return new RealMoneroProvider();
  return new MockChainProvider();
}

const provider: ChainProvider = resolveProvider();

app.get("/health", (c) => {
  return c.json({ ok: true, service: "cypher-api", provider: provider.name });
});

app.post("/wallets/import", async (c) => {
  const payload = await c.req.json().catch(() => null);
  const parsed = importWalletSchema.safeParse(payload);

  if (!parsed.success) {
    return c.json(
      {
        ok: false,
        error: "invalid_payload",
        details: parsed.error.flatten(),
      },
      400,
    );
  }

  const id = crypto.randomUUID();
  const record: WalletRecord = {
    id,
    address: parsed.data.address,
    viewKey: parsed.data.viewKey,
    restoreHeight: parsed.data.restoreHeight ?? 0,
    createdAt: new Date().toISOString(),
  };

  wallets.set(id, record);

  return c.json({
    ok: true,
    walletId: id,
    watchOnly: true,
  });
});

app.post("/wallets/register-local", async (c) => {
  const payload = await c.req.json().catch(() => null);
  const parsed = registerLocalWalletSchema.safeParse(payload);

  if (!parsed.success) {
    return c.json(
      {
        ok: false,
        error: "invalid_payload",
        details: parsed.error.flatten(),
      },
      400,
    );
  }

  const id = crypto.randomUUID();
  const record: WalletRecord = {
    id,
    // placeholder until local mnemonic derivation is wired
    address: `pending-address:${parsed.data.walletLabel}:${id}`,
    viewKey: `pending-view-key:${id}`,
    restoreHeight: parsed.data.restoreHeight ?? 0,
    createdAt: new Date().toISOString(),
  };

  wallets.set(id, record);

  return c.json({
    ok: true,
    walletId: id,
    walletLabel: parsed.data.walletLabel,
    mode: "mnemonic-local",
  });
});

app.get("/wallets/:id", (c) => {
  const id = c.req.param("id");
  const wallet = wallets.get(id);

  if (!wallet) {
    return c.json({ ok: false, error: "wallet_not_found" }, 404);
  }

  return c.json({
    ok: true,
    wallet: {
      id: wallet.id,
      address: wallet.address,
      restoreHeight: wallet.restoreHeight,
      createdAt: wallet.createdAt,
      // NOTE: do NOT return viewKey from API responses.
    },
  });
});

app.get("/wallets/:id/balance", async (c) => {
  const id = c.req.param("id");
  const wallet = wallets.get(id);

  if (!wallet) {
    return c.json({ ok: false, error: "wallet_not_found" }, 404);
  }

  try {
    const balance = await provider.getBalance(wallet);

    return c.json({
      ok: true,
      walletId: wallet.id,
      ...balance,
      source: provider.name,
    });
  } catch (error) {
    return c.json(
      {
        ok: false,
        error: "provider_balance_error",
        provider: provider.name,
        message: error instanceof Error ? error.message : "Unknown provider error",
      },
      502,
    );
  }
});

app.get("/wallets/:id/txs", async (c) => {
  const id = c.req.param("id");
  const wallet = wallets.get(id);

  if (!wallet) {
    return c.json({ ok: false, error: "wallet_not_found" }, 404);
  }

  const limit = Number(c.req.query("limit") ?? 10);

  try {
    const txs = await provider.getTransactions(wallet, Number.isFinite(limit) ? limit : 10);

    return c.json({
      ok: true,
      walletId: wallet.id,
      txs,
      source: provider.name,
    });
  } catch (error) {
    return c.json(
      {
        ok: false,
        error: "provider_txs_error",
        provider: provider.name,
        message: error instanceof Error ? error.message : "Unknown provider error",
      },
      502,
    );
  }
});

const port = Number(process.env.PORT ?? 8787);

console.log(`Cypher API listening on http://localhost:${port} (provider: ${provider.name})`);

Bun.serve({
  port,
  fetch: app.fetch,
});
