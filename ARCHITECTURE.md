# Cartethyia Architecture

Self-hosted AI gateway (Bun + TypeScript + Elysia + PostgreSQL, Redis
optional). It accepts several client protocols, normalizes them into one
canonical model, routes across provider accounts and models with admission
and capability checks, and dispatches through SSRF-validated direct egress
or pooled HTTP/SOCKS5 proxies. The same process serves the React dashboard.

This file is only the map: how to read the docs, the big picture, and where
each layer lives. Implementation detail lives in the per-folder docs linked
below — each layer doc sits beside the code it describes, named for its layer.

## How to read the docs

- Start here, then open the doc for the top-level folder you need. Each opens the same way — purpose, layout, key behaviors with concrete file/function names — and closes with the fitting section: a "How to extend" checklist (console, network, protocol, providers, security) or rules/invariants (observability, persistence, runtime, transport, workers).
- One doc per top-level `src/` folder, covering its whole subtree, named for its layer in caps (`src/providers/PROVIDERS.md`) — no two docs share a basename, subfolders carry no doc of their own.
- Product usage and runtime configuration stay in `README.md` and
  `.env.example`. Agent-only repo rules stay in `AGENTS.md`.

## Big picture

Two planes share one process (`src/main.ts` → `bootstrap()` in
`src/runtime/lifecycle.ts` → `buildProductionDeps()` in
`src/runtime/dependencies.ts` → `createGatewayApp()` in
`src/app.ts`):

- **Data plane** — `/v1/*` inference traffic: transport (pipeline, routing,
  dispatch) → protocol codecs → provider adapters → network egress, guarded
  by security layers and recorded by observability.
- **Control plane** — `/console/api/*` dashboard API plus the public
  `/share/:token` enrollment surface: per-tenant operator mutations and
  metadata-only child-key telemetry with trusted-IP enrollment limits.

`src/app.ts` exposes one builder, `createGatewayApp(deps)`, whose `mode` selects how much mounts:

- `{ mode: "production", … }` — full process, both planes.
- `createGatewayShell(options)` — route-only: dashboard, `/health`, `/metrics`; no transport pipeline, no console router. Not a spare path — two consumers depend on it: `bun run build:aot` captures the Elysia manifest with `bootstrap()` skipped and no database, and routing/static-serving tests need the console router absent.

One request: ordered pipeline (readiness → ingress policy → single body read → client identity → API-key auth → canonical parse → route prepare) → `RoutingEngine.plan()` (alias → combo → ambiguity → eligibility → capability filter → provider-routing reorder) → leases (admission → pool slot → reservation) → adapter dispatch (stream primed before the 200 commits) → `completeAttempt()` (usage, health, capture, exactly one telemetry row); the persistence batch also updates durable account and API-key usage totals. The per-IP abuse check isn't a pipeline stage: it mounts at the composition root on the `request` hook so it counts routeless requests, ahead of readiness and client identity.

## Doc map

### Data plane

| Layer | Doc | Covers |
|---|---|---|
| transport | `src/transport/TRANSPORT.md` | Canonical core, lifecycle, ingress pipeline (`middleware/` split by role: `body-policy`, `request-context`, `gateway-guards`, `error-lifecycle`), surface codecs, preparation/state, capability/alias/combo, routing plan, dispatch, error taxonomy |
| protocol | `src/protocol/PROTOCOL.md` | Canonical↔wire codecs, registry dispatcher, shared primitives |
| network | `src/network/NETWORK.md` | Validated egress, SSRF policy, pool agents, weighted admission, retry/dedup rules |
| security | `src/security/SECURITY.md` | Data plane: identity → IP-abuse → API-key auth → admission; shared primitives: crypto, headers; console-scoped CSRF |
| providers | `src/providers/PROVIDERS.md` | Registry, metadata × capabilities × lazy import, seeding/catalog/discovery, OAuth kit, quota shape and window engine, per-provider adapters, runtime operations |

### Control plane

| Layer | Doc | Covers |
|---|---|---|
| console | `src/console/CONSOLE.md` | Conventions, cookie auth and first-boot, catalog/accounts, account concurrency and usage, API-key modes and shared-key enrollment/activity, alias/combo and pools, CLI tools, quotas, runtime settings, backup/restore |

### Foundation

| Layer | Doc | Covers |
|---|---|---|
| persistence | `src/persistence/PERSISTENCE.md` | Schema groups, durable telemetry totals, pool singletons, migration ledger, stores |
| runtime | `src/runtime/RUNTIME.md` | Boot order, shutdown stages, timeout/backoff/TTL-cache |
| observability | `src/observability/OBSERVABILITY.md` | Telemetry pipeline, logger, metrics, payloads, gauges |
| workers | `src/workers/WORKERS.md` | Scheduler semantics, task table, OAuth + quota sweeps |

## Other trees (not covered by layer docs)

- `dashboard/` — React/Vite landing, console, and public share enrollment
  mounted through the shared `index.html`. Every entry imports
  `dashboard/src/styles/base.css` then its one app-specific extension
  (`console.css`, `landing.css`, or `share.css`) directly; no style barrel.
  Tests live under `dashboard/test/`; route and browser-safe import rules
  live in `dashboard/README.md`.
- `test/` — backend tests mirroring `src/`, plus `contracts`, `integration`,
  `architecture` (naming contracts), `frontend`, `helpers`; loose root files
  such as `config.test.ts` and `config-env-drift.test.ts` cover cross-cutting
  config contracts.
- `scripts/` — flat operational scripts (`ops-*`, `build-*`, `ci-*`).
- `migrations/` — `0000_baseline.sql` is the complete schema, applied automatically on first boot and recorded in `cartethyia_schema_migrations`; later `NNNN_*.sql` files are forward migrations for databases that already recorded an earlier one. A schema change edits the baseline and adds the next numbered file.
- Committed protobuf output lives under the provider integrations that
  consume it (`src/providers/integrations/*/generated/`).

## Conventions (short version)

- `src/` is production code only, no `*.test.ts`. No `index.ts` barrels —
  import concrete files. `import type` for type-only imports.
- Entity directories use role filenames: `contracts.ts` (types + validation
  + operations + routes), `routes.ts`, `store.ts`, `service.ts`, `errors.ts`.
- Console writes end with audit + snapshot invalidation. Telemetry is
  metadata-only and best-effort — it never blocks or throws into requests.
- Every security layer is fail-closed: store outages reject, never bypass.
- Details in each layer doc; this file intentionally does not duplicate them.
