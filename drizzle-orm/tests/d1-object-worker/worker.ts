/// <reference types="@cloudflare/workers-types/experimental" />

import { drizzle } from '~/d1-object/driver.ts';
import { DrizzleD1Object } from '~/d1-object/object.ts';
import type { D1ObjectQueryEvent } from '~/d1-object/types.ts';
import { posts, schema } from './schema.ts';

export interface Env {
	BLOG_DATABASE: DurableObjectNamespace<BlogDatabase>;
}

export class BlogDatabase extends DrizzleD1Object<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env, { readReplication: false });
		ctx.blockConcurrencyWhile(async () => {
			ctx.storage.sql.exec(`
				create table if not exists posts (
					id integer primary key autoincrement,
					title text not null
				)
			`);
		});
	}

	db = drizzle(this.ctx, { schema, logger: false });

	listPosts() {
		return this.db.query.posts.findMany({
			orderBy: (posts, { asc }) => [asc(posts.id)],
		});
	}
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function errorDetails(error: unknown): unknown {
	if (!(error instanceof Error)) {
		return String(error);
	}

	return {
		message: error.message,
		stack: error.stack,
		cause: error.cause === undefined ? undefined : errorDetails(error.cause),
	};
}

function createBlogDb(env: Env, events: D1ObjectQueryEvent[] = []) {
	return drizzle<BlogDatabase, typeof schema>(
		env.BLOG_DATABASE.getByName('blog'),
		{
			schema,
			logger: false,
			onQuery(event) {
				events.push(event);
			},
		},
	);
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const events: D1ObjectQueryEvent[] = [];
		const db = createBlogDb(env, events);

		try {
			if (url.pathname === '/seed') {
				await db.insert(posts).values([
					{ title: 'first post' },
					{ title: 'second post' },
				]).run();
				return json({
					bookmark: db.d1.getBookmark(),
					events,
				});
			}

			if (url.pathname === '/posts') {
				const rows = await db.query.posts.findMany({
					orderBy: (posts, { asc }) => [asc(posts.id)],
				});
				return json({
					posts: rows,
					bookmark: db.d1.getBookmark(),
					events,
				});
			}

			if (url.pathname === '/client-posts') {
				const rows = await db.d1.client.listPosts();
				return json({
					posts: rows,
					bookmark: db.d1.getBookmark(),
					events,
				});
			}

			if (url.pathname === '/mixed') {
				await db.insert(posts).values({ title: 'from remote db' }).run();
				const directRows = await db.query.posts.findMany({
					orderBy: (posts, { asc }) => [asc(posts.id)],
				});
				const methodRows = await db.d1.client.listPosts();
				return json({
					directPosts: directRows,
					methodPosts: methodRows,
					bookmark: db.d1.getBookmark(),
					events,
				});
			}

			return json({ error: 'Not found' }, 404);
		} catch (error) {
			return json({
				error: errorDetails(error),
			}, 500);
		}
	},
} satisfies ExportedHandler<Env>;
