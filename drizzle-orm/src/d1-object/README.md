# Drizzle ORM | D1 Object driver

Use `drizzle-orm/d1-object` inside Cloudflare D1 application objects backed by Durable Object storage.

```ts
import { DrizzleD1Object, drizzle } from 'drizzle-orm/d1-object';
import * as schema from './schema';

export class BlogDatabase extends DrizzleD1Object<Env> {
	db = drizzle(this.ctx, { schema });

	async listPosts() {
		return this.db.query.posts.findMany({
			limit: 10,
		});
	}
}
```

## Bookmark sessions

D1 read-replica bookmarks are consistency metadata, so application methods do not need to accept or return them directly. Wrap the Durable Object stub with `drizzle()` at the request boundary instead.

```ts
import { drizzle } from 'drizzle-orm/d1-object';

export async function fetch(request: Request, env: Env) {
	const id = env.BLOG_DATABASE.idFromName('blog');
	const db = drizzle<BlogDatabase>(env.BLOG_DATABASE.get(id), {
		bookmark: request.headers.get('x-d1-bookmark'),
	});

	const posts = await db.d1.client.listPosts();

	return Response.json({ posts }, {
		headers: {
			'x-d1-bookmark': db.d1.getBookmark() ?? '',
		},
	});
}
```

`drizzle()` creates a request-bound bookmark session. With `DrizzleD1Object` stubs, Drizzle uses the object's internal `createDrizzleSession()` RPC hook so method calls can be issued eagerly while the object executes them in causal order. The session sends the current bookmark with each call, waits for that bookmark inside the object before running application code, and stores the updated bookmark returned by the object. Custom stubs without `createDrizzleSession()` still work through the older local call queue. Use a separate database when calls are intentionally independent.

## Remote Drizzle sessions

The remote database keeps Drizzle's normal query syntax while SQL still executes inside the Durable Object. Extending `DrizzleD1Object` supplies the reserved query RPC handlers, so the object does not need to define CRUD methods for direct Drizzle queries.

```ts
import { drizzle } from 'drizzle-orm/d1-object';
import * as schema from './schema';

export async function fetch(request: Request, env: Env) {
	const db = drizzle<BlogDatabase, typeof schema>(
		env.BLOG_DATABASE.getByName('blog'),
		{
			schema,
			bookmark: request.headers.get('x-d1-bookmark'),
		},
	);

	const posts = await db.query.posts.findMany({
		limit: 10,
	});

	return Response.json({ posts }, {
		headers: {
			'x-d1-bookmark': db.d1.getBookmark() ?? '',
		},
	});
}
```

`db.d1.client` and direct Drizzle queries share bookmark state through the same remote Durable Object session, so they can be mixed safely inside one request. The remote database compiles query-builder and relational-query calls into `runDrizzleQuery()` RPC envelopes. Reads wait for the current session bookmark and may run on the primary or a replica. Writes are marked with `write: true`; if the call lands on a replica, the object forwards it to the primary before executing the SQL.

Calls are sequenced before awaiting their results, so independent promises can be pipelined through one request-bound session without losing causal order:

```ts
const write = db.insert(posts).values({ title: 'hello' }).run();
const read = db.query.posts.findMany();

const [, posts] = await Promise.all([write, read]);
```

The read RPC can be sent before the write resolves, but the Durable Object session drains calls by sequence. The read still executes after the write and observes the bookmark produced by that write. Returned bookmarks are also applied by sequence on the Worker side, so a slower older response cannot roll `db.d1.getBookmark()` back behind a newer completed call.

Sequential `await` code remains sequential:

```ts
await db.insert(posts).values({ title: 'hello' }).run();
const posts = await db.query.posts.findMany();
```

Remote multi-statement transactions are intentionally unsupported. Put transactional workflows in named Durable Object methods and run `db.transaction()` inside the object so the whole transaction executes in one object invocation.

The lower-level `createD1ObjectSession()` helper remains available for code that prefers an explicit `{ client, db }` wrapper.

The internal `createDrizzleSession()` RPC hook is reserved for Drizzle and is not exposed on `db.d1.client`.

The low-level `db.d1.waitForBookmark()` and `db.d1.getCurrentBookmark()` helpers on in-object databases remain available when an application needs custom bookmark handling.

## Read replication

Read replication is configured from the object constructor by default. Disable it when every method should run on the primary object.

```ts
export class BlogDatabase extends DrizzleD1Object<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env, { readReplication: false });
	}

	db = drizzle(this.ctx, { schema });
}
```

Mark write methods as primary-only so replica calls forward to the primary object before application code runs.

```ts
import { DrizzleD1Object, d1PrimaryMethods, drizzle } from 'drizzle-orm/d1-object';
import * as schema from './schema';

export class BlogDatabase extends DrizzleD1Object<Env> {
	static override readonly primaryMethods = d1PrimaryMethods<BlogDatabase>()('createPost');

	db = drizzle(this.ctx, { schema });

	async createPost(title: string) {
		return this.db.insert(schema.posts).values({ title }).run();
	}
}
```

The protected `assertPrimary()` helper remains available when a method needs a dynamic primary-only guard.

Raw SQL is write-classified by default. Use `db.d1.readAll()`, `db.d1.readGet()`, or `db.d1.readValues()` for explicit raw reads that may run on replicas.

## Migrations

Run bundled migrations through an object method:

```ts
import migrations from '../drizzle/migrations';

export class BlogDatabase extends DrizzleD1Object<Env> {
	db = drizzle(this.ctx, { schema });

	applyMigrations() {
		return this.applyDrizzleMigrations(migrations);
	}
}
```
