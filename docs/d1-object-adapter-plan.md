# Drizzle Adapter Plan for D1 Application Objects

## Summary

D1's vNext model should not be treated as another remote `D1Database` binding. It is a SQLite-backed Durable Object plus the read replication API. Drizzle should add a first-class D1 application-object adapter that creates the database client inside the Durable Object from `DurableObjectState`, uses `ctx.storage.sql` for local SQL execution, exposes bookmark helpers, configures read replication, and provides primary-forwarding migration and primary-only transaction paths.

Recommended package shape:

```ts
import { DrizzleD1Object, drizzle } from "drizzle-orm/d1-object";
import { migrate } from "drizzle-orm/d1-object/migrator";
```

The existing `drizzle-orm/d1` package should remain the legacy D1 binding driver. The existing `drizzle-orm/durable-sqlite` package should remain the low-level sync Durable Object SQLite driver. The new `d1-object` package should build on the durable-sqlite execution model, but add D1-specific object state, replication, bookmark, migration, and safety behavior.

For what we build now, use the current Durable Objects Wrangler configuration model: `durable_objects.bindings` plus `migrations.new_sqlite_classes`. Do not base implementation examples on the future-state `[exports.<ClassName>]` / `storage = "sqlite"` syntax used in the D1 vNext docs branch.

## Research Inputs

Cloudflare D1 vNext docs from `~/src/cloudflare-docs`:

| Source | Key points |
| --- | --- |
| `src/content/docs/d1/index.mdx` | D1 is a Durable Object that owns one logical SQLite database. The front Worker routes to the object. SQL runs inside the object via `ctx.storage.sql`. |
| `src/content/docs/d1/reference/architecture.mdx` | The front Worker should not run SQL. Object names are the database boundary and scaling unit. Reads can run on replicas. Writes run on the primary. |
| `src/content/docs/d1/reference/compatibility-matrix.mdx` | Old D1 binding APIs map to Durable Object namespace routing, `ctx.storage.sql`, `transactionSync()`, bookmarks, and adapter-managed routing. |
| `src/content/docs/d1/best-practices/read-replication.mdx` | `ctx.primaryStub` identifies replicas. `configureReadReplication({ mode: "auto" })` runs on the primary. Writes should route primary-only or forward from replicas. Bookmarks preserve read consistency. |
| `src/content/docs/d1/frameworks/astro.mdx` | Framework adapters should generate the front Worker plus backend Durable Object, route writes primary-only, forward writes from replicas as a safety path, propagate `x-d1-bookmark`, and provide a local SQL client. |
| `src/content/docs/d1/orms/drizzle.mdx` | Target Drizzle API is `DrizzleD1Object` plus `drizzle(this.ctx, { schema })`; the docs sketch currently passes `readReplication: { mode: "auto" }`, but this plan makes that the default. Drizzle should consume cursors synchronously and use query metadata where possible. |
| `src/content/docs/d1/reference/migrations.mdx` | SQL migrations must run through a primary-only object method and be tracked in a table inside the object database. |
| `src/content/docs/d1/observability/metrics-analytics.mdx` | Adapters should log object identity, primary or replica status, forwarded writes, query duration, `rowsRead`, `rowsWritten`, and bookmarks. |
| Current Durable Objects docs | Deployed SQLite-backed Durable Objects are configured with `durable_objects.bindings` and a Durable Object class migration using `new_sqlite_classes`. |
| `https://orm.drizzle.team/docs/connect-cloudflare-do` | Existing Drizzle docs page covers `drizzle-orm/durable-sqlite`, current Wrangler DO config, and migration-in-constructor examples. Its source was not found in this repository checkout, so updating it is likely a separate docs-site task. |

Drizzle repo findings:

| Source | Key points |
| --- | --- |
| `drizzle-orm/src/d1/driver.ts` and `session.ts` | Current D1 driver targets the old async `D1Database` binding API: `prepare().bind().run/all/raw`, `D1Database.batch()`, and SQL `begin`/`commit` transactions. |
| `drizzle-orm/src/durable-sqlite/driver.ts` and `session.ts` | Existing Durable Object SQLite driver already uses `SQLiteSyncDialect`, `DurableObjectStorage.sql.exec()`, and `transactionSync()`. It is the best local execution base. |
| `drizzle-orm/src/sqlite-proxy/*` | The docs sketch's proxy approach is useful for async RPC forwarding, but it is not enough for production because it loses `transactionSync()` semantics unless carefully constrained. |
| `drizzle-orm/src/sqlite-core/session.ts` | Drizzle has distinct sync and async SQLite execution modes. This matters because DO SQL is sync, while primary-stub RPC forwarding is async. |
| `drizzle-orm/src/durable-sqlite/migrator.ts` | Durable SQLite migrations are already bundled for Worker runtime use, but need primary-only enforcement and D1 object helpers. |
| `drizzle-kit/src/cli/validations/sqlite.ts` | Drizzle Kit already recognizes `durable-sqlite`, but currently disables `migrate`, `push`, `pull`, and `studio` for it. |

## Design Principles

1. D1 SQL must run inside the Durable Object.
2. The front Worker chooses the object name. Drizzle must not invent sharding or object naming.
3. The `d1-object` adapter should be D1-specific, not a silent replacement for the legacy `d1` binding adapter.
4. Local query execution should use `ctx.storage.sql.exec()` directly and consume `SqlStorageCursor` synchronously before any `await`.
5. Read replication should be enabled by default for `d1-object`, with `readReplication: false` as the explicit opt-out.
6. Primary-only routing is the preferred write path. Replica-to-primary forwarding is a safety path, not the primary consistency model.
7. Transactions must use `ctx.storage.transactionSync()` and must run on the primary for any write transaction.
8. Bookmark helpers should be explicit and small. Framework adapters can decide whether to store bookmarks in headers, cookies, or request-local state.
9. Query metadata should drive write classification for Drizzle-built queries. SQL text classification should only be a fallback for raw SQL.

## Public API

### New Subpath

Add a new subpath:

```ts
drizzle-orm/d1-object
drizzle-orm/d1-object/migrator
```

Do not overload `drizzle-orm/d1` for this model. The existing `d1` package is tied to `D1Database` bindings and should remain available for existing users.

### Object Client

Target user code:

```ts
import { DrizzleD1Object, drizzle } from "drizzle-orm/d1-object";
import * as schema from "./schema";

export interface Env {
  BLOG_DATABASE: DurableObjectNamespace<BlogDatabase>;
}

export class BlogDatabase extends DrizzleD1Object<Env> {
  db = drizzle(this.ctx, {
    schema,
  });

  async listPosts(bookmark: string | null) {
    await this.db.d1.waitForBookmark(bookmark);

    const posts = this.db.query.posts.findMany({
      limit: 10,
    });

    return {
      posts,
      bookmark: await this.db.d1.getCurrentBookmark(),
    };
  }
}
```

`await` should continue to work because Drizzle sync query results are awaitable enough for JS call sites, but the adapter should document that local DO SQLite queries execute synchronously unless users opt into async forwarding mode.

Read replication should be enabled by default for this adapter. Users should only need to pass `readReplication: false` for local tests, unsupported runtimes, or deliberate primary-only deployments.

### Runtime Setup

Runtime setup belongs to the Durable Object class, not lazy query execution. `drizzle()` should construct the SQL client and session. It should not call `ctx.blockConcurrencyWhile()` on demand from arbitrary request paths.

Default setup path:

```ts
export class BlogDatabase extends DrizzleD1Object<Env> {
  db = drizzle(this.ctx, { schema });
}
```

Opt-out path:

```ts
export class BlogDatabase extends DrizzleD1Object<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, { readReplication: false });
  }

  db = drizzle(this.ctx, { schema });
}
```

For users who do not extend `DrizzleD1Object`, expose an explicit setup helper and require it to run from the Durable Object constructor:

```ts
export class BlogDatabase extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    setupD1Object(ctx);
  }

  db = drizzle(this.ctx, { schema });
}
```

Implementation requirements:

1. `DrizzleD1Object` constructor calls `setupD1Object(ctx, config)`.
2. `setupD1Object()` uses `ctx.blockConcurrencyWhile()` once per object instance.
3. `setupD1Object()` configures read replication by default and skips it only for `readReplication: false`.
4. `drizzle()` does not start replication setup. It can assert that setup happened in development builds if a reliable marker exists.
5. Docs should show creating the Drizzle client as a class field or constructor property, not inside each RPC method.

### Current Wrangler Config

Use current Durable Objects configuration for buildable examples and tests.

`wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "d1-drizzle-app",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-12",
  "durable_objects": {
    "bindings": [
      {
        "name": "BLOG_DATABASE",
        "class_name": "BlogDatabase"
      }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["BlogDatabase"]
    }
  ]
}
```

`wrangler.toml`:

```toml
name = "d1-drizzle-app"
main = "src/index.ts"
compatibility_date = "2026-06-12"

[[durable_objects.bindings]]
name = "BLOG_DATABASE"
class_name = "BlogDatabase"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["BlogDatabase"]
```

Do not use this future-state config for the implementation plan:

```toml
[exports.BlogDatabase]
type = "durable_object"
storage = "sqlite"
```

That syntax is useful as a docs sketch for the D1 application-object direction, but current Drizzle tests, examples, and integration guidance should use current Durable Objects bindings and migrations.

### Config

```ts
type D1ObjectRuntimeConfig = {
  readReplication?:
    | false
    | {
        mode: "auto";
        enabled?: boolean | ((ctx: DurableObjectState) => boolean | Promise<boolean>);
      };
};

type D1ObjectDrizzleConfig<TSchema extends Record<string, unknown>> = DrizzleConfig<TSchema> & {
  replicaWrites?: "throw";
  onQuery?: (event: D1ObjectQueryEvent) => void;
};
```

Recommended defaults:

| Option | Default | Reason |
| --- | --- | --- |
| `readReplication` on `DrizzleD1Object` / `setupD1Object()` | `{ mode: "auto" }` | D1 application objects should scale reads through replicas by default. Users can opt out with `false`. |
| `replicaWrites` | `"throw"` | Query-level forwarding has consistency and transaction traps. Framework/front-worker primary routing should be the normal path. |
| `onQuery` | undefined | Metrics should be easy to add without changing the generic logger API first. |

Do not add `replicaWrites: "forward-query"` to the sync `d1-object` MVP. Query-level forwarding needs an async path because primary-stub RPC cannot preserve the sync return shape or `transactionSync()` semantics.

### D1 Helpers

Attach a small D1 namespace to the returned database:

```ts
db.d1.isReplica(): boolean;
db.d1.configureReadReplication(): Promise<void>;
db.d1.waitForBookmark(bookmark: string | null | undefined): Promise<void>;
db.d1.getCurrentBookmark(): Promise<string>;
db.d1.getBookmarkForTime(timestamp: number | Date): Promise<string>;
db.d1.onNextSessionRestoreBookmark(bookmark: string): Promise<string>;
db.d1.readAll<T>(query: SQLWrapper | string): T[];
db.d1.readGet<T>(query: SQLWrapper | string): T | undefined;
db.d1.readValues<T extends unknown[]>(query: SQLWrapper | string): T[];
```

Potential later helpers:

```ts
db.d1.withBookmark<T>(bookmark: string | null, fn: () => T | Promise<T>): Promise<T>;
db.d1.getLastForwardedBookmark(): string | undefined;
```

Avoid HTTP-specific helpers in core Drizzle. Framework adapters should own `x-d1-bookmark` headers, cookies, and framework-local session state.

### Base Class

`DrizzleD1Object<Env>` should be a convenience class for shared D1 object behavior:

```ts
export abstract class DrizzleD1Object<Env = unknown> extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env, config?: D1ObjectRuntimeConfig);
  protected isReplica(): boolean;
  protected assertPrimary(operation?: string): void;
  protected configureD1ReadReplication(config?: { mode: "auto" }): Promise<void>;
  runDrizzleQuery(request: D1ObjectQueryRequest): Promise<D1ObjectQueryResponse>;
  applyDrizzleMigrations(migrations: D1ObjectMigration[]): Promise<{ applied: string[] }>;
}
```

The base class should not try to choose an object name or route incoming HTTP requests. Those are application and framework-adapter concerns.

## Implementation Plan

### Phase 1: Shared Durable Object SQL Core

Refactor `drizzle-orm/src/durable-sqlite/session.ts` so result mapping can be shared by `durable-sqlite` and `d1-object`.

Concrete changes:

1. Introduce an internal `SqlStorageExecutor` helper that accepts `DurableObjectStorage` or `SqlStorage` and returns rows plus cursor metadata.
2. Replace `res.raw().toArray()` with `Array.from(res.raw())` to use the standard iterator contract and avoid relying on non-standard iterator methods.
3. Always consume the `SqlStorageCursor` before reading final `rowsRead` and `rowsWritten` for metrics.
4. Preserve object-row results for unmapped `.all()` and raw-array results for mapped Drizzle selections and `.values()`.
5. Keep `durable-sqlite` sync and backward compatible.

Key detail:

`ctx.storage.sql.exec()` is synchronous. The core execution helper should not `await` between cursor creation and cursor consumption.

### Phase 2: Add `d1-object` Local Adapter

Create:

```txt
drizzle-orm/src/d1-object/index.ts
drizzle-orm/src/d1-object/driver.ts
drizzle-orm/src/d1-object/session.ts
drizzle-orm/src/d1-object/migrator.ts
drizzle-orm/src/d1-object/object.ts
```

The first version should wrap `DurableObjectState`, not only `DurableObjectStorage`:

```ts
export function drizzle<TSchema extends Record<string, unknown>>(
  ctx: DurableObjectState,
  config?: D1ObjectDrizzleConfig<TSchema>,
): DrizzleD1Database<TSchema> & { d1: D1ObjectHelpers; $client: DurableObjectState };
```

Why `DurableObjectState`:

| Need | Requires state? | Reason |
| --- | --- | --- |
| SQL execution | No | `ctx.storage.sql` is enough. |
| `transactionSync()` | No | `ctx.storage` is enough. |
| Bookmarks | No for current bookmark, yes for future `waitForBookmark` typing | APIs live under `ctx.storage`. |
| Read replication config | Yes | `ctx.configureReadReplication()` is on state. |
| Replica detection | Yes | `ctx.primaryStub` is on state in the proposed API. |
| Forwarding safety | Yes | Uses `ctx.primaryStub`. |

Initial behavior:

1. `DrizzleD1Object` and `setupD1Object()` own replication setup. `drizzle()` only constructs the Drizzle database client.
2. Unless runtime setup receives `readReplication: false`, setup configures replication only from the primary with `{ mode: "auto" }`.
3. If `ctx.primaryStub` exists and a mutation is attempted with `replicaWrites: "throw"`, throw a clear Drizzle error telling the user to route the object stub with `routingMode: "primary-only"` or use an explicit primary-forwarding method such as `applyDrizzleMigrations()`.
4. Allow classified reads on primary and replicas.
5. Expose bookmark helpers on `db.d1`.
6. Keep query execution synchronous and transaction-safe.

### Phase 3: Transactions and Batch

Transactions are where the docs sketch needs the most production hardening.

Rules:

1. Use `ctx.storage.transactionSync()` for Drizzle `db.transaction()`.
2. Do not allow async work inside a transaction callback.
3. If `ctx.primaryStub` exists, throw before starting a transaction unless the adapter can prove it is read-only. The initial version should throw for all replica transactions because Drizzle cannot statically inspect the callback.
4. Use SQLite savepoints for nested transactions if `transactionSync()` nesting is not enough or does not produce Drizzle-compatible rollback behavior.
5. Add a `batch()` method for D1 migration compatibility if feasible, but do not rely on old D1 `batch()` semantics.

Suggested `batch()` behavior:

| Batch contents | Behavior |
| --- | --- |
| Reads only | Execute sequentially on current primary or replica. |
| Contains writes on primary | Execute inside `transactionSync()` and map each result. |
| Contains writes on replica | Throw by default. Later, optionally forward the whole batch to primary. |

Do not implement write transactions by issuing `BEGIN` and then awaiting arbitrary Promise work. That would violate the Durable Object SQLite model and lose the safety of `transactionSync()`.

### Phase 4: Query Classification

Use Drizzle query metadata where possible:

```ts
queryMetadata?: {
  type: "select" | "update" | "delete" | "insert";
  tables: string[];
}
```

Classification rules:

| Query source | Classification |
| --- | --- |
| Drizzle insert/update/delete builders | Write from `queryMetadata.type`. |
| Drizzle select builders | Read from `queryMetadata.type`. |
| Raw `db.run()` | Write. |
| Raw `db.all()`, `db.get()`, `db.values()` | Write by default because raw SQL has no reliable metadata. |
| Explicit raw read helper | Read only when the user opts into a read-marked raw helper. |
| PRAGMA | Write by default unless exposed through an explicit read helper. |
| DDL | Write. |

Do not use a regex as the production write classifier. It is too easy to mutate through raw SQL shapes such as CTEs or PRAGMAs. Add explicit raw-read helpers for users who need raw SQL on replicas:

```ts
db.d1.readAll<T>(query: SQLWrapper | string): T[];
db.d1.readGet<T>(query: SQLWrapper | string): T | undefined;
db.d1.readValues<T extends unknown[]>(query: SQLWrapper | string): T[];
```

These helpers should still execute locally and synchronously through `ctx.storage.sql`; they only communicate user intent to the replica safety checks.

### Phase 5: Future Async Query Forwarding

The docs sketch uses `sqlite-proxy` and forwards individual writes from a replica to the primary. That is useful, but it should not be part of the sync `d1-object` MVP.

Problems with query-level forwarding:

1. It requires async RPC to `ctx.primaryStub`, while local DO SQL and `transactionSync()` are synchronous.
2. If a replica forwards a write query and then reads locally, the local replica may not yet have the primary's bookmark unless the adapter waits before the read.
3. `db.d1.getCurrentBookmark()` on the replica can return a replica bookmark, not the bookmark produced by the forwarded write, unless the query response carries the primary bookmark and the adapter tracks it.
4. It cannot safely forward arbitrary Drizzle transaction callbacks because callbacks are code, not serializable query plans.
5. The same Drizzle query method should not sometimes return sync rows and sometimes await a primary-stub RPC.

If added, implement it as a separate async adapter or helper, not as an option on the sync adapter:

```ts
import { drizzleAsync } from "drizzle-orm/d1-object/async";

const db = drizzleAsync(this.ctx, {
  schema,
});
```

Forwarded query request:

```ts
type D1ObjectQueryRequest = {
  sql: string;
  params: unknown[];
  method: "run" | "all" | "get" | "values";
  responseMode: "object" | "array";
  write: boolean;
  tables?: string[];
  queryType?: "select" | "insert" | "update" | "delete";
};
```

Forwarded query response:

```ts
type D1ObjectQueryResponse = {
  rows: unknown[];
  bookmark?: string;
  rowsRead?: number;
  rowsWritten?: number;
  servedBy: "primary" | "replica";
  forwarded?: boolean;
};
```

Required semantics for forwarding mode:

1. Primary execution returns a bookmark after writes.
2. Replica adapter stores the last forwarded bookmark.
3. Before a later local read in the same adapter instance, either wait for the stored bookmark or route that read to primary based on a documented consistency option.
4. Transactions still throw on replicas.
5. Batch with writes forwards as a whole batch, not per statement.

### Phase 6: Migrations

Add `drizzle-orm/d1-object/migrator` for migrations that run inside the object.

Recommended API:

```ts
import { migrate } from "drizzle-orm/d1-object/migrator";
import migrations from "../drizzle/migrations";

export class BlogDatabase extends DrizzleD1Object<Env> {
  db = drizzle(this.ctx, { schema });

  applyMigrations() {
    return this.applyDrizzleMigrations(migrations);
  }
}
```

Rules:

1. `DrizzleD1Object.applyDrizzleMigrations()` forwards to `ctx.primaryStub.applyDrizzleMigrations()` when called on a replica.
2. On the primary, run migrations with `transactionSync()`.
3. Use Drizzle's existing migration metadata format where possible.
4. Keep the default migrations table as `__drizzle_migrations` for consistency with other Drizzle SQLite drivers, unless the team explicitly decides D1 vNext needs `d1_migrations`.
5. Allow `migrationsTable` override.
6. Expose `migrate(db, migrations, config?)` as a lower-level primary-local helper for users who know they are already on the primary.
7. Provide an object method helper on `DrizzleD1Object` for docs and framework adapters:

```ts
await env.BLOG_DATABASE
  .getByName("site:example.com")
  .applyDrizzleMigrations(generatedDrizzleMigrations);
```

If a future routing API lets the front Worker request the primary for known write RPCs, callers can still use it to avoid the extra replica-to-primary hop. Correctness must not depend on that route hint because `applyDrizzleMigrations()` forwards to the primary itself.

Drizzle Kit should continue to generate SQLite SQL. Full remote `push`, `pull`, `studio`, and automatic object discovery should not be MVP goals because the D1 application-object model has no global database binding or REST SQL endpoint.

### Phase 7: Observability

Add a D1-specific query event rather than overloading the existing logger too much.

```ts
type D1ObjectQueryEvent = {
  sql: string;
  params: unknown[];
  method: "run" | "all" | "get" | "values";
  queryType?: "select" | "insert" | "update" | "delete";
  tables?: string[];
  durationMs: number;
  rowsRead?: number;
  rowsWritten?: number;
  rowCount?: number;
  servedBy: "primary" | "replica";
  forwarded: boolean;
};
```

Implementation requirements:

1. Capture `rowsRead` and `rowsWritten` only after cursor consumption.
2. Mark whether the object was a replica using `ctx.primaryStub !== undefined`.
3. Mark `forwarded` for query-forwarding mode.
4. Keep params redaction as a future option if sensitive query logs are a concern.

### Phase 8: Drizzle Kit Guidance

MVP Drizzle Kit changes:

1. Add `driver: "d1-object"` as an alias or successor to `durable-sqlite` for generation-only configs.
2. Keep `generate` working exactly like SQLite.
3. Keep the Drizzle Kit CLI `migrate`, `push`, `pull`, and `studio` commands disabled unless the user provides a deployed Worker admin endpoint or a local object test harness.
4. Keep the runtime migrator package enabled through `drizzle-orm/d1-object/migrator` and `DrizzleD1Object.applyDrizzleMigrations()`.
5. Improve error messages so users know schema migrations must be called through a primary-forwarding Durable Object method, not the generic CLI path.

Potential later config:

```ts
export default defineConfig({
  schema: "./src/schema.ts",
  dialect: "sqlite",
  driver: "d1-object",
  out: "./drizzle",
});
```

Potential later migration runner support:

```ts
dbCredentials: {
  workerUrl: "https://example.com/admin/d1-migrate",
  token: process.env.MIGRATION_TOKEN!,
  objectName: "site:example.com",
}
```

That should be a later feature because it requires an application-owned authenticated endpoint and does not generalize as cleanly as the legacy D1 REST API.

### Phase 9: Drizzle Docs Consolidation

The current Drizzle docs page at `https://orm.drizzle.team/docs/connect-cloudflare-do` should be updated as part of this effort. Its source does not appear in this repository checkout, so this likely needs a separate docs-site PR or coordination with the docs owner.

Docs follow-up deliverables:

1. Locate the source repo and source file for `orm.drizzle.team/docs/connect-cloudflare-do`.
2. Open a docs-site PR that updates `connect-cloudflare-do` and adds or updates the D1 application-object page.
3. Open a Cloudflare docs PR that aligns `src/content/docs/d1/orms/drizzle.mdx` with the final Drizzle package names and runtime semantics.
4. Cross-link both docs sites in the same release window so users do not see conflicting guidance.
5. Include the docs-site PR links in the Drizzle adapter release notes.

Consolidation target:

| Page or section | Role after this adapter |
| --- | --- |
| `connect-cloudflare-do` | Keep as the low-level Cloudflare Durable Objects SQLite page for `drizzle-orm/durable-sqlite`. |
| New `connect-cloudflare-d1-object` or renamed Cloudflare D1 section | Make this the recommended D1 application-object page for `drizzle-orm/d1-object`. |
| Existing `connect-cloudflare-d1` | Keep as the legacy `D1Database` binding page or clearly label it as binding-based. |

Required docs changes:

1. Preserve current Wrangler Durable Objects config examples using `durable_objects.bindings` and `migrations.new_sqlite_classes`.
2. Add a prominent choice point: use `d1-object` for D1 application objects and read replication; use `durable-sqlite` only when you want raw Durable Object SQLite without D1 semantics.
3. Update the recommended D1 example to `import { DrizzleD1Object, drizzle } from "drizzle-orm/d1-object"`.
4. Show `drizzle(this.ctx, { schema })` with read replication enabled by default.
5. Document `readReplication: false` as the explicit opt-out for local tests or primary-only deployments.
6. Move migrations out of constructor examples for D1 application objects; recommend a primary-forwarding admin/RPC method instead.
7. Keep the current migration-in-constructor pattern only on the low-level Durable Object SQLite page, and caveat that it is not appropriate for read-replicated D1 objects because replicas are read-only.
8. Add bookmark examples using `db.d1.waitForBookmark()` and `db.d1.getCurrentBookmark()`.
9. Cross-link Cloudflare's D1 Drizzle docs and Drizzle's Cloudflare D1 object docs so the two pages agree on package names, config, and migration flow.
10. Remove or fix the current sample typo where `usersAll` is logged as `users`.

## Compatibility Strategy

| Existing package | Keep? | Change? |
| --- | --- | --- |
| `drizzle-orm/d1` | Yes | Keep legacy `D1Database` binding support. Consider docs language like "D1 binding driver" once `d1-object` exists. |
| `drizzle-orm/d1/migrator` | Yes | Keep for legacy binding migrations. |
| `drizzle-orm/durable-sqlite` | Yes | Keep as low-level sync DO SQLite driver. Refactor internals but preserve public API. |
| `drizzle-orm/durable-sqlite/migrator` | Yes | Keep for existing users. Share logic with `d1-object/migrator`. |
| `drizzle-orm/sqlite-proxy` | Yes | Reuse ideas for async forwarding, but do not make it the only implementation path for D1 object SQL. |

Naming recommendation:

Use `d1-object`, not `d1-vnext`, because it describes the runtime model and will age better after vNext becomes normal D1.

## Test Plan

### Unit Tests

Add tests around a fake `SqlStorage` and `SqlStorageCursor`:

1. Object rows from `.all()` without selected fields.
2. Raw arrays from mapped selections and `.values()`.
3. Duplicate column name joins use raw arrays and do not lose data through object key collisions.
4. `rowsRead` and `rowsWritten` are captured after cursor consumption.
5. `Array.from(cursor.raw())` works with published Workers types.
6. Query metadata classifies select/insert/update/delete correctly.
7. Raw SQL fallback classifier treats DDL and DML as writes.
8. `db.d1.waitForBookmark(null)` is a no-op.
9. Omitted `readReplication` config calls `configureReadReplication()` on the primary by default.
10. `readReplication: false` skips replication setup.
11. Replica write with default config throws a helpful error.

### Integration Tests

Extend `integration-tests/tests/sqlite/durable-objects` or add a parallel `d1-object` suite:

1. Create a real Durable Object with SQLite storage.
2. Run Drizzle schema queries inside the object.
3. Run inserts with `returning()`.
4. Run joins and relation queries.
5. Run `transactionSync()` rollback tests.
6. Run nested transaction/savepoint tests.
7. Run bundled migrations through a primary-forwarding object method.
8. Verify bookmark helper methods call storage APIs.
9. Verify Wrangler fixture config uses `durable_objects.bindings` plus `migrations.new_sqlite_classes`, not `[exports]`.
10. Mock `ctx.primaryStub` until Miniflare/workerd exposes read replication locally.

### Type Tests

Add type coverage for:

1. `drizzle(this.ctx, { schema })` infers relational query types.
2. `DrizzleD1Object<Env>` works with `DurableObjectNamespace<BlogDatabase>`.
3. `db.d1` helpers are present and typed.
4. Legacy `drizzle-orm/d1` types remain unchanged.
5. `d1-object` does not require `@miniflare/d1`.

## Docs Changes Needed After Implementation

Cloudflare docs should show the real package path and semantics:

1. Prefer `drizzle-orm/d1-object` for the application-object model.
2. Keep `drizzle-orm/d1` examples only for legacy database bindings.
3. Use current Durable Objects config examples: `durable_objects.bindings` and `migrations.new_sqlite_classes`.
4. Avoid `[exports.<ClassName>]` / `storage = "sqlite"` in buildable Drizzle examples until that config model is available in Wrangler.
5. Document that front Workers and framework adapters should route known writes with `routingMode: "primary-only"` once that runtime API is available.
6. Document query forwarding only as future async-adapter work with transaction limitations.
7. Document `db.d1.waitForBookmark()` and `db.d1.getCurrentBookmark()` as explicit consistency tools.
8. Document migrations as primary-only object methods.
9. Explain that Drizzle does not choose object names or shard boundaries.

## Open Questions

1. When, if ever, should Drizzle docs switch from current `durable_objects.bindings` / `new_sqlite_classes` examples to future `[exports]` examples?
2. Should a future async forwarding adapter use `drizzle-orm/d1-object/async`, `drizzle-orm/d1-object-proxy`, or another package shape?
3. Should `db.d1.getCurrentBookmark()` return the local storage bookmark only, or the latest primary bookmark observed through forwarded writes in a future async forwarding adapter?
4. Does nested `ctx.storage.transactionSync()` provide the same behavior Drizzle expects from savepoints, or should the adapter implement explicit savepoints?
5. Should Drizzle Kit introduce `driver: "d1-object"` immediately, or keep `driver: "durable-sqlite"` until the runtime API is stable?
6. Should the migration table stay `__drizzle_migrations` for Drizzle consistency, or switch to the docs sketch's `d1_migrations` for D1 branding?

## Recommended MVP Scope

Ship MVP with:

1. `drizzle-orm/d1-object` subpath.
2. `drizzle(ctx, config)` that wraps `DurableObjectState` and executes local SQL through `ctx.storage.sql`.
3. `DrizzleD1Object` base class with primary/replica helpers and migration method support.
4. `db.d1` bookmark helpers.
5. Default-on read replication setup with `readReplication: false` opt-out.
6. Primary-forwarding migration runner.
7. Transaction support using `transactionSync()`.
8. Clear replica-write errors by default.
9. Query metrics hook.
10. Tests for local execution, migrations, transactions, helpers, and replica-write errors.

Defer:

1. Separate async query-forwarding adapter.
2. Remote Drizzle Kit `push`, `pull`, and `studio` for D1 objects.
3. Automatic HTTP bookmark propagation in core Drizzle.
4. Any global object-name registry or object discovery feature.

## Why This Shape

The main trap is treating D1 vNext like a remote database with an async query callback. That makes write forwarding look easy, but it fights the core advantage of the new model: local synchronous SQLite inside the object and `transactionSync()` for correctness. Drizzle should expose that local model first, then layer D1-specific replication and bookmark helpers around it.

The Astro adapter and similar framework adapters should own request routing, primary-only write routing, and bookmark transport. Drizzle should own schema-aware SQL generation, cursor mapping, transaction boundaries, migrations inside the object, and a small set of D1 object helpers.
