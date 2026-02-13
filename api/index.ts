import { Hono } from "hono";
import { z } from "zod";

const app = new Hono();

const importWalletSchema = z.object({
  address: z.string().min(20, "address looks too short"),
  viewKey: z.string().min(20, "view key looks too short"),
  restoreHeight: z.number().int().nonnegative().optional(),
});

type WalletRecord = {
  id: string;
  address: string;
  viewKey: string;
  restoreHeight: number;
  createdAt: string;
};

const wallets = new Map<string, WalletRecord>();

app.get("/health", (c) => {
  return c.json({ ok: true, service: "cypher-api" });
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

app.get("/wallets/:id/balance", (c) => {
  const id = c.req.param("id");
  const wallet = wallets.get(id);

  if (!wallet) {
    return c.json({ ok: false, error: "wallet_not_found" }, 404);
  }

  // TODO: Replace mock values with Monero provider integration.
  return c.json({
    ok: true,
    walletId: wallet.id,
    network: "stagenet",
    balanceAtomic: "0",
    unlockedAtomic: "0",
    syncedHeight: wallet.restoreHeight,
    lastUpdatedAt: new Date().toISOString(),
    source: "mock",
  });
});

app.get("/wallets/:id/txs", (c) => {
  const id = c.req.param("id");
  const wallet = wallets.get(id);

  if (!wallet) {
    return c.json({ ok: false, error: "wallet_not_found" }, 404);
  }

  // TODO: Replace with provider-backed transaction history.
  return c.json({
    ok: true,
    walletId: wallet.id,
    txs: [],
    source: "mock",
  });
});

const port = Number(process.env.PORT ?? 8787);

console.log(`Cypher API listening on http://localhost:${port}`);

Bun.serve({
  port,
  fetch: app.fetch,
});
