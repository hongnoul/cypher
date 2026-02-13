# Cypher

A watch-only Monero wallet extension for Chrome-based browsers.

## Vision

Cypher aims to make Monero wallet visibility feel as simple as modern extension wallets—without pretending Monero has the same data model as transparent chains.

Our goal is to provide a clean, fast, trustworthy **watch-only** experience:
- See balance and transaction activity
- Track due updates and refresh state reliably
- Keep users clearly informed about privacy/trust tradeoffs
- Never blur the line between watch-only and spending capability

## Why this exists

Most lightweight extension wallets are designed for transparent chains where account state is easy to query from RPC/indexers. Monero is different: privacy-by-design adds complexity.

Cypher focuses on practical UX first:
- Start lightweight (provider-backed watch-only)
- Build robust abstractions
- Improve privacy and infrastructure over time

## Product principles

1. **Watch-only first**
   - No spend key handling in MVP
   - No transaction signing in MVP

2. **Security over speed**
   - Encrypt sensitive local data
   - Minimize permissions
   - Avoid remote code and unsafe patterns

3. **Clear trust boundaries**
   - Make data-source trust explicit
   - Support provider abstraction from day one

4. **Progressive hardening**
   - MVP usability first
   - Privacy and infra upgrades in planned stages

## MVP scope

- Import watch-only wallet data
  - Wallet name
  - Monero address
  - Optional private view key
  - Optional restore height
- Fetch and display
  - Current XMR balance
  - Recent transaction history
  - Last updated/sync metadata
- UX essentials
  - Manual refresh
  - Loading/error/empty states
  - Clear “Watch-only” labeling

## Non-goals (MVP)

- Sending transactions
- Managing seed phrase or private spend key
- Running a full Monero node inside the extension
- Advanced portfolio analytics

## Architecture direction

- **UI:** WXT + React + TypeScript
- **State:** lightweight client state store
- **Storage:** encrypted local persistence
- **Data layer:** provider interface (swappable)

Provider abstraction is mandatory so we can move from early provider APIs to stronger infrastructure without rewriting core app logic.

## Planned roadmap

1. **MVP (watch-only, provider-backed)**
2. **Multi-provider + fallback + better reliability**
3. **Privacy improvements (self-hosted/backend relay options)**
4. **Advanced account and sync tooling**
5. **(Optional future) signing architecture and security audit path**

## Current status

Project scaffold initialized with WXT + React.

Next milestone: implement watch-only import flow and first provider-backed balance fetch.
