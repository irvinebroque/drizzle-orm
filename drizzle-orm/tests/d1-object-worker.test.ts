import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness, type TestHarness } from 'wrangler';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

let server: TestHarness;

type Post = {
	id: number;
	title: string;
};

type QueryEvent = {
	method: string;
	queryType?: string;
	tables?: string[];
	servedBy: string;
	forwarded?: boolean;
};

beforeAll(async () => {
	server = createTestHarness({
		root: packageRoot,
		workers: [{
			config: {
				name: 'd1-object-worker-test',
				main: './tests/d1-object-worker/worker.ts',
				compatibility_date: '2026-06-13',
				durable_objects: {
					bindings: [{
						name: 'BLOG_DATABASE',
						class_name: 'BlogDatabase',
					}],
				},
				migrations: [{
					tag: 'v1',
					new_sqlite_classes: ['BlogDatabase'],
				}],
			},
		}],
	});
	await server.listen();
}, 60_000);

afterAll(async () => {
	await server.close();
}, 60_000);

async function readJson<T>(response: { ok: boolean; json(): Promise<unknown> }): Promise<T> {
	const body = await response.json();
	if (!response.ok) {
		throw new Error(JSON.stringify(body, null, 2));
	}
	return body as T;
}

test('remote Drizzle sessions run through a real Worker and Durable Object', async () => {
	const seed = await readJson<{ bookmark: string; events: QueryEvent[] }>(
		await server.fetch('/seed', { method: 'POST' }),
	);
	expect(seed.bookmark).toEqual(expect.any(String));
	expect(seed.events).toEqual([
		expect.objectContaining({
			method: 'run',
			queryType: 'insert',
			tables: ['posts'],
			servedBy: 'primary',
			forwarded: false,
		}),
	]);

	const posts = await readJson<{ posts: Post[]; bookmark: string; events: QueryEvent[] }>(
		await server.fetch('/posts'),
	);
	expect(posts.posts).toEqual([
		{ id: 1, title: 'first post' },
		{ id: 2, title: 'second post' },
	]);
	expect(posts.bookmark).toEqual(expect.any(String));
	expect(posts.events).toEqual([
		expect.objectContaining({
			method: 'values',
			servedBy: 'primary',
			forwarded: false,
		}),
	]);

	const fromMethod = await readJson<{ posts: Post[]; bookmark: string; events: QueryEvent[] }>(
		await server.fetch('/client-posts'),
	);
	expect(fromMethod.posts).toEqual(posts.posts);
	expect(fromMethod.bookmark).toEqual(expect.any(String));
	expect(fromMethod.events).toEqual([]);

	const mixed = await readJson<{
		directPosts: Post[];
		methodPosts: Post[];
		bookmark: string;
		events: QueryEvent[];
	}>(await server.fetch('/mixed', { method: 'POST' }));
	expect(mixed.directPosts).toEqual([
		{ id: 1, title: 'first post' },
		{ id: 2, title: 'second post' },
		{ id: 3, title: 'from remote db' },
	]);
	expect(mixed.methodPosts).toEqual(mixed.directPosts);
	expect(mixed.bookmark).toEqual(expect.any(String));
	expect(mixed.events).toEqual([
		expect.objectContaining({
			method: 'run',
			queryType: 'insert',
			tables: ['posts'],
			servedBy: 'primary',
		}),
		expect.objectContaining({
			method: 'values',
			servedBy: 'primary',
		}),
	]);

	const pipelined = await readJson<{ posts: Post[]; bookmark: string; events: QueryEvent[] }>(
		await server.fetch('/pipelined', { method: 'POST' }),
	);
	expect(pipelined.posts).toEqual([
		{ id: 1, title: 'first post' },
		{ id: 2, title: 'second post' },
		{ id: 3, title: 'from remote db' },
		{ id: 4, title: 'hello' },
	]);
	expect(pipelined.bookmark).toEqual(expect.any(String));
	expect(pipelined.events).toEqual([
		expect.objectContaining({
			method: 'run',
			queryType: 'insert',
			tables: ['posts'],
			servedBy: 'primary',
		}),
		expect.objectContaining({
			method: 'values',
			servedBy: 'primary',
		}),
	]);
});
