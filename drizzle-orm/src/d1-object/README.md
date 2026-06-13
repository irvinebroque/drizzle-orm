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

D1 read-replica bookmarks are consistency metadata, so application methods do not need to accept or return them directly. Wrap the Durable Object stub with `createD1ObjectSession()` at the request boundary instead.

```ts
import { createD1ObjectSession } from 'drizzle-orm/d1-object';

export async function fetch(request: Request, env: Env) {
	const id = env.BLOG_DATABASE.idFromName('blog');
	const blog = createD1ObjectSession<BlogDatabase>(env.BLOG_DATABASE.get(id), {
		bookmark: request.headers.get('x-d1-bookmark'),
	});

	const posts = await blog.client.listPosts();

	return Response.json({ posts }, {
		headers: {
			'x-d1-bookmark': blog.getBookmark() ?? '',
		},
	});
}
```

`createD1ObjectSession()` sends the current bookmark with each method call, waits for that bookmark inside the object before running the method, and stores the updated bookmark returned by the object. Calls through one session are serialized to preserve causal order. Use a separate session when calls are intentionally independent.

## Remote Drizzle sessions

Use `session.db` when application code should keep Drizzle's normal query syntax while SQL still executes inside the Durable Object.

```ts
import { createD1ObjectSession } from 'drizzle-orm/d1-object';
import * as schema from './schema';

export async function fetch(request: Request, env: Env) {
	const blog = createD1ObjectSession<BlogDatabase, typeof schema>(
		env.BLOG_DATABASE.getByName('blog'),
		{
			schema,
			bookmark: request.headers.get('x-d1-bookmark'),
		},
	);

	const posts = await blog.db.query.posts.findMany({
		limit: 10,
	});

	return Response.json({ posts }, {
		headers: {
			'x-d1-bookmark': blog.getBookmark() ?? '',
		},
	});
}
```

`session.client` and `session.db` share bookmark state and serialize calls through the same queue, so they can be mixed safely inside one request. Direct Drizzle writes are marked as writes in the query RPC and forward from replicas to the primary object. Multi-statement transactions should remain Durable Object methods so the whole transaction runs inside one object invocation.

The low-level `db.d1.waitForBookmark()` and `db.d1.getCurrentBookmark()` helpers remain available when an application needs custom bookmark handling.

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
