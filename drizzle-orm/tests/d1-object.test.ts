/// <reference types="@cloudflare/workers-types" />

import { expect, test, vi } from 'vitest';
import { createD1ObjectSession } from '~/d1-object/client.ts';
import { drizzle } from '~/d1-object/driver.ts';
import { D1ObjectReplicaWriteError, isD1ObjectReplicaWriteError } from '~/d1-object/errors.ts';
import { migrate } from '~/d1-object/migrator.ts';
import { SQLiteD1ObjectSession } from '~/d1-object/session.ts';
import { setupD1Object } from '~/d1-object/setup.ts';
import type { D1ObjectMethodRequest, D1ObjectQueryRequest } from '~/d1-object/types.ts';
import { isD1ObjectMutationSql } from '~/d1-object/utils.ts';
import { sql } from '~/sql/sql.ts';
import { integer, sqliteTable } from '~/sqlite-core';
import { SQLiteSyncDialect } from '~/sqlite-core/dialect.ts';

vi.mock('cloudflare:workers', () => ({
	DurableObject: class {
		protected ctx: DurableObjectState;
		protected env: unknown;

		constructor(ctx: DurableObjectState, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

const users = sqliteTable('users', {
	id: integer(),
});

class FakeCursor<T extends Record<string, SqlStorageValue>> {
	columnNames: string[] = [];
	rowsRead = 0;
	rowsWritten = 0;
	private index = 0;

	constructor(private rows: T[], private rawRows: SqlStorageValue[][] = rows.map((row) => Object.values(row))) {}

	next() {
		const value = this.rows[this.index++];
		return value === undefined ? { done: true as const } : { done: false as const, value };
	}

	toArray() {
		return this.rows;
	}

	raw<U extends SqlStorageValue[]>() {
		return this.rawRows[Symbol.iterator]() as IterableIterator<U>;
	}

	[Symbol.iterator]() {
		return this.rows[Symbol.iterator]();
	}
}

function createState(options: {
	primaryStub?: unknown;
	rows?: Record<string, SqlStorageValue>[];
	rawRows?: SqlStorageValue[][];
	configureReadReplication?: (config: { mode: 'auto' | 'disabled' }) => Promise<void>;
	waitForBookmark?: (bookmark: string) => Promise<void>;
} = {}) {
	const calls: { sql: string; params: unknown[] }[] = [];
	const state = {
		primaryStub: options.primaryStub,
		configureReadReplication: options.configureReadReplication,
		storage: {
			sql: {
				exec(query: string, ...params: unknown[]) {
					calls.push({ sql: query, params });
					return new FakeCursor(options.rows ?? [], options.rawRows);
				},
			},
			transactionSync<T>(callback: () => T): T {
				return callback();
			},
			getCurrentBookmark: async () => 'bookmark',
			getBookmarkForTime: async () => 'bookmark-at-time',
			onNextSessionRestoreBookmark: async () => 'restore-bookmark',
			waitForBookmark: options.waitForBookmark,
		},
		blockConcurrencyWhile(callback: () => Promise<unknown>) {
			void callback();
		},
	} as unknown as DurableObjectState & { primaryStub?: unknown };

	return { state, calls };
}

test('setupD1Object configures read replication by default on primary', async () => {
	const configureReadReplication = vi.fn(async () => {});
	const state = {
		blockConcurrencyWhile(callback: () => Promise<unknown>) {
			return callback();
		},
		configureReadReplication,
	} as unknown as DurableObjectState;

	setupD1Object(state);
	await Promise.resolve();

	expect(configureReadReplication).toHaveBeenCalledWith({ mode: 'auto' });
});

test('setupD1Object disables read replication when disabled', async () => {
	const configureReadReplication = vi.fn(async () => {});
	const state = {
		blockConcurrencyWhile(callback: () => Promise<unknown>) {
			return callback();
		},
		configureReadReplication,
	} as unknown as DurableObjectState;

	setupD1Object(state, { readReplication: false });
	await Promise.resolve();

	expect(configureReadReplication).toHaveBeenCalledWith({ mode: 'disabled' });
});

test('setupD1Object tolerates missing read replication API when disabled', () => {
	const state = {
		blockConcurrencyWhile(callback: () => Promise<unknown>) {
			return callback();
		},
	} as unknown as DurableObjectState;

	expect(() => setupD1Object(state, { readReplication: false })).not.toThrow();
});

test('raw writes expose typed replica write errors through wrapped causes', () => {
	const { state } = createState({ primaryStub: {} });
	const db = drizzle(state);

	let thrown: unknown;
	try {
		db.run(sql`insert into users (id) values (1)`);
	} catch (error) {
		thrown = error;
	}

	expect(thrown).toBeDefined();
	expect(thrown).toHaveProperty('message', "Failed to run the query 'insert into users (id) values (1)'");
	expect((thrown as { cause?: unknown }).cause).toBeInstanceOf(D1ObjectReplicaWriteError);
	expect(isD1ObjectReplicaWriteError(thrown)).toBe(true);
});

test('query builder writes throw typed replica write errors directly', () => {
	const { state } = createState({ primaryStub: {} });
	const db = drizzle(state);

	expect(() => db.insert(users).values({ id: 1 }).run()).toThrow(D1ObjectReplicaWriteError);
});

test('explicit raw read helpers run on replicas', () => {
	const { state, calls } = createState({
		primaryStub: {},
		rows: [{ id: 1 }],
		rawRows: [[1]],
	});
	const db = drizzle(state);

	expect(db.d1.readAll<{ id: number }>(sql`select id from users`)).toEqual([{ id: 1 }]);
	expect(db.d1.readGet<{ id: number }>(sql`select id from users`)).toEqual({ id: 1 });
	expect(db.d1.readValues<[number]>(sql`select id from users`)).toEqual([[1]]);
	expect(calls).toHaveLength(3);
});

test('explicit raw read helpers reject mutation SQL', () => {
	const { state, calls } = createState({ primaryStub: {} });
	const db = drizzle(state);

	expect(() => db.d1.readAll(sql`insert into users (id) values (1)`)).toThrow(
		'D1 object read helpers only accept SELECT or EXPLAIN statements',
	);
	expect(() => db.d1.readGet('with recent as (select id from users) select * from recent')).toThrow(
		'D1 object read helpers only accept SELECT or EXPLAIN statements',
	);
	expect(calls).toHaveLength(0);
});

test('bookmark helper tolerates missing bookmark waiting on primary objects only', async () => {
	const primary = drizzle(createState().state);
	const replica = drizzle(createState({ primaryStub: {} }).state);

	await expect(primary.d1.waitForBookmark('client-bookmark')).resolves.toBeUndefined();
	await expect(replica.d1.waitForBookmark('client-bookmark')).rejects.toThrow(
		'D1 bookmark waiting is not available in this runtime',
	);
});

test('D1 object mutation SQL detection skips comments and allows reads', () => {
	expect(isD1ObjectMutationSql('-- comment\n /* next */ select * from users')).toBe(false);
	expect(isD1ObjectMutationSql('explain select * from users')).toBe(false);
	expect(isD1ObjectMutationSql('delete from users')).toBe(true);
	expect(isD1ObjectMutationSql('with recent as (select * from users) select * from recent')).toBe(true);
});

test('$count runs on replicas', async () => {
	const { state, calls } = createState({
		primaryStub: {},
		rawRows: [[3]],
	});
	const db = drizzle(state);

	await expect(db.$count(users)).resolves.toBe(3);
	expect(calls[0]?.sql).toContain('select count(*)');
});

test('mapped relational-style reads run on replicas', () => {
	const { state } = createState({
		primaryStub: {},
		rawRows: [[1]],
	});
	const session = new SQLiteD1ObjectSession(state, new SQLiteSyncDialect(), undefined);
	const query = session.prepareQuery(
		{ sql: 'select 1', params: [] },
		undefined,
		'all',
		true,
		(rows) => rows,
	);

	expect(query.all()).toEqual([[1]]);
});

test('migrations forward from replicas to primary', async () => {
	const applyDrizzleMigrations = vi.fn(async () => ({ applied: ['m0001'] }));
	const { state } = createState({ primaryStub: { applyDrizzleMigrations } });
	const { DrizzleD1Object } = await import('~/d1-object/object.ts');
	const config = { journal: { entries: [] }, migrations: {} };

	const result = await DrizzleD1Object.prototype.applyDrizzleMigrations.call({ ctx: state }, config);

	expect(result).toEqual({ applied: ['m0001'] });
	expect(applyDrizzleMigrations).toHaveBeenCalledWith(config);
});

test('migrate preserves original errors when rollback throws', () => {
	const rollback = vi.fn(() => {
		throw new Error('rollback');
	});
	const db = {
		transaction(callback: (tx: { rollback(): never }) => void) {
			callback({ rollback });
		},
		run: vi.fn(() => {
			throw new Error('create failed');
		}),
		values: vi.fn(),
	} as unknown as Parameters<typeof migrate>[0];

	expect(() => migrate(db, { journal: { entries: [] }, migrations: {} })).toThrow('create failed');
	expect(rollback).toHaveBeenCalled();
});

test('query RPC waits for bookmarks and returns updated bookmarks', async () => {
	const waitForBookmark = vi.fn(async () => {});
	const { state } = createState({ configureReadReplication: async () => {}, waitForBookmark });
	const { DrizzleD1Object } = await import('~/d1-object/object.ts');
	class TestObject extends DrizzleD1Object<Record<string, never>> {}
	const object = new TestObject(state, {}, { readReplication: false });

	const result = await object.runDrizzleQuery({
		sql: 'select id from users',
		params: [],
		method: 'all',
		responseMode: 'object',
		write: false,
		bookmark: 'client-bookmark',
	});

	expect(waitForBookmark).toHaveBeenCalledWith('client-bookmark');
	expect(result.bookmark).toBe('bookmark');
});

test('query RPC treats missing bookmark waiting as a no-op on primary objects', async () => {
	const { state } = createState();
	const { DrizzleD1Object } = await import('~/d1-object/object.ts');
	class TestObject extends DrizzleD1Object<Record<string, never>> {}
	const object = new TestObject(state, {}, { readReplication: false });

	await expect(object.runDrizzleQuery({
		sql: 'select id from users',
		params: [],
		method: 'all',
		responseMode: 'object',
		write: false,
		bookmark: 'client-bookmark',
	})).resolves.toMatchObject({
		bookmark: 'bookmark',
		servedBy: 'primary',
	});
});

test('query RPC requires bookmark waiting on replicas', async () => {
	const { state } = createState({ primaryStub: {} });
	const { DrizzleD1Object } = await import('~/d1-object/object.ts');
	class TestObject extends DrizzleD1Object<Record<string, never>> {}
	const object = new TestObject(state, {});

	await expect(object.runDrizzleQuery({
		sql: 'select id from users',
		params: [],
		method: 'all',
		responseMode: 'object',
		write: false,
		bookmark: 'client-bookmark',
	})).rejects.toThrow('D1 bookmark waiting is not available in this runtime');
});

test('object method RPC waits for bookmarks and returns updated bookmarks', async () => {
	const waitForBookmark = vi.fn(async () => {});
	const { state } = createState({ configureReadReplication: async () => {}, waitForBookmark });
	const { DrizzleD1Object } = await import('~/d1-object/object.ts');
	class TestObject extends DrizzleD1Object<Record<string, never>> {
		async listPosts(limit: number) {
			return [{ id: limit }];
		}
	}
	const object = new TestObject(state, {}, { readReplication: false });

	const result = await object.runDrizzleObjectMethod({
		method: 'listPosts',
		args: [10],
		bookmark: 'client-bookmark',
	});

	expect(waitForBookmark).toHaveBeenCalledWith('client-bookmark');
	expect(result).toEqual({
		value: [{ id: 10 }],
		bookmark: 'bookmark',
	});
});

test('primary object methods forward from replicas before running user code', async () => {
	const runDrizzleObjectMethod = vi.fn(async (request: D1ObjectMethodRequest) => ({
		value: { title: request.args[0] },
		bookmark: 'primary-bookmark',
	}));
	const waitForBookmark = vi.fn(async () => {});
	const { state } = createState({
		primaryStub: { runDrizzleObjectMethod },
		waitForBookmark,
	});
	const { DrizzleD1Object, d1PrimaryMethods } = await import('~/d1-object/object.ts');
	class TestObject extends DrizzleD1Object<Record<string, never>> {
		static override readonly primaryMethods = d1PrimaryMethods<TestObject>()('createPost');

		async createPost(_title: string) {
			throw new Error('replica method body should not run');
		}
	}
	const object = new TestObject(state, {});

	const result = await object.runDrizzleObjectMethod({
		method: 'createPost',
		args: ['hello'],
		bookmark: 'client-bookmark',
	});

	expect(runDrizzleObjectMethod).toHaveBeenCalledWith({
		method: 'createPost',
		args: ['hello'],
		bookmark: 'client-bookmark',
	});
	expect(waitForBookmark).not.toHaveBeenCalled();
	expect(result).toEqual({
		value: { title: 'hello' },
		bookmark: 'primary-bookmark',
	});
});

test('object method RPC rejects reserved methods', async () => {
	const { state } = createState({ configureReadReplication: async () => {} });
	const { DrizzleD1Object } = await import('~/d1-object/object.ts');
	class TestObject extends DrizzleD1Object<Record<string, never>> {}
	const object = new TestObject(state, {}, { readReplication: false });

	await expect(object.runDrizzleObjectMethod({
		method: 'runDrizzleQuery',
		args: [],
	})).rejects.toThrow("D1 object method 'runDrizzleQuery' cannot be called through a Drizzle object session");
});

test('D1 object sessions forward and update bookmarks', async () => {
	const requests: D1ObjectMethodRequest[] = [];
	const session = createD1ObjectSession<{
		listPosts(limit: number): Promise<{ id: number }[]>;
		createPost(title: string): void;
	}>({
		async runDrizzleObjectMethod(request) {
			requests.push(request);
			return {
				value: request.method === 'listPosts' ? [{ id: request.args[0] as number }] : undefined,
				bookmark: `bookmark-${requests.length}`,
			};
		},
	}, { bookmark: 'initial-bookmark' });

	await expect(session.client.listPosts(10)).resolves.toEqual([{ id: 10 }]);
	expect(requests[0]).toEqual({
		method: 'listPosts',
		args: [10],
		bookmark: 'initial-bookmark',
	});
	expect(session.bookmark).toBe('bookmark-1');
	expect(session.getBookmark()).toBe('bookmark-1');

	session.setBookmark('manual-bookmark');
	await session.client.createPost('hello');
	expect(requests[1]).toEqual({
		method: 'createPost',
		args: ['hello'],
		bookmark: 'manual-bookmark',
	});
	expect(session.bookmark).toBe('bookmark-2');
});

test('D1 object session db runs Drizzle relational queries over query RPC', async () => {
	const requests: D1ObjectQueryRequest[] = [];
	const session = createD1ObjectSession<Record<string, never>, { users: typeof users }>({
		async runDrizzleObjectMethod() {
			throw new Error('object method should not run');
		},
		async runDrizzleQuery(request) {
			requests.push(request);
			return {
				rows: [[1]],
				bookmark: 'query-bookmark',
				servedBy: 'replica',
			};
		},
	}, { schema: { users }, bookmark: 'initial-bookmark' });

	await expect(session.db.query.users.findMany()).resolves.toEqual([{ id: 1 }]);
	expect(requests[0]).toMatchObject({
		method: 'values',
		responseMode: 'array',
		write: false,
		bookmark: 'initial-bookmark',
	});
	expect(session.getBookmark()).toBe('query-bookmark');
});

test('D1 object remote drizzle exposes query and session helpers on db', async () => {
	const queryRequests: D1ObjectQueryRequest[] = [];
	const methodRequests: D1ObjectMethodRequest[] = [];
	const db = drizzle<{
		listPosts(limit: number): Promise<{ id: number }[]>;
	}, { users: typeof users }>({
		async runDrizzleObjectMethod(request) {
			methodRequests.push(request);
			return {
				value: [{ id: request.args[0] as number }],
				bookmark: 'method-bookmark',
			};
		},
		async runDrizzleQuery(request) {
			queryRequests.push(request);
			return {
				rows: [[1]],
				bookmark: 'query-bookmark',
				servedBy: 'replica',
			};
		},
	}, { schema: { users }, bookmark: 'initial-bookmark' });

	await expect(db.query.users.findMany()).resolves.toEqual([{ id: 1 }]);
	expect(queryRequests[0]).toMatchObject({
		method: 'values',
		responseMode: 'array',
		write: false,
		bookmark: 'initial-bookmark',
	});
	expect(db.d1.getBookmark()).toBe('query-bookmark');

	db.d1.setBookmark('manual-bookmark');
	await expect(db.d1.client.listPosts(10)).resolves.toEqual([{ id: 10 }]);
	expect(methodRequests[0]).toEqual({
		method: 'listPosts',
		args: [10],
		bookmark: 'manual-bookmark',
	});
	expect(db.d1.bookmark).toBe('method-bookmark');
});

test('D1 object session db marks writes for primary forwarding', async () => {
	const requests: D1ObjectQueryRequest[] = [];
	const session = createD1ObjectSession<Record<string, never>, { users: typeof users }>({
		async runDrizzleObjectMethod() {
			throw new Error('object method should not run');
		},
		async runDrizzleQuery(request) {
			requests.push(request);
			return {
				rows: [],
				bookmark: 'write-bookmark',
				servedBy: 'primary',
				forwarded: true,
			};
		},
	}, { schema: { users }, bookmark: 'initial-bookmark' });

	await session.db.insert(users).values({ id: 1 }).run();

	expect(requests[0]).toMatchObject({
		method: 'run',
		responseMode: 'object',
		write: true,
		queryType: 'insert',
		tables: ['users'],
		bookmark: 'initial-bookmark',
	});
	expect(session.getBookmark()).toBe('write-bookmark');
});

test('D1 object sessions serialize calls with the latest bookmark', async () => {
	let releaseFirst!: () => void;
	const requests: D1ObjectMethodRequest[] = [];
	const session = createD1ObjectSession<{
		first(): Promise<string>;
		second(): Promise<string>;
	}>({
		async runDrizzleObjectMethod(request) {
			requests.push(request);
			if (request.method === 'first') {
				await new Promise<void>((resolve) => {
					releaseFirst = resolve;
				});
			}
			return {
				value: request.method,
				bookmark: `bookmark-${requests.length}`,
			};
		},
	}, { bookmark: 'initial-bookmark' });

	const first = session.client.first();
	const second = session.client.second();
	await Promise.resolve();

	expect(requests).toEqual([{
		method: 'first',
		args: [],
		bookmark: 'initial-bookmark',
	}]);

	releaseFirst();
	await expect(first).resolves.toBe('first');
	await expect(second).resolves.toBe('second');
	expect(requests[1]).toEqual({
		method: 'second',
		args: [],
		bookmark: 'bookmark-1',
	});
	expect(session.bookmark).toBe('bookmark-2');
});

test('D1 object sessions serialize db and client calls with the latest bookmark', async () => {
	let releaseQuery!: () => void;
	const queryRequests: D1ObjectQueryRequest[] = [];
	const methodRequests: D1ObjectMethodRequest[] = [];
	const session = createD1ObjectSession<{
		listPosts(): Promise<string>;
	}, { users: typeof users }>({
		async runDrizzleObjectMethod(request) {
			methodRequests.push(request);
			return {
				value: 'posts',
				bookmark: 'method-bookmark',
			};
		},
		async runDrizzleQuery(request) {
			queryRequests.push(request);
			await new Promise<void>((resolve) => {
				releaseQuery = resolve;
			});
			return {
				rows: [[1]],
				bookmark: 'query-bookmark',
				servedBy: 'replica',
			};
		},
	}, { schema: { users }, bookmark: 'initial-bookmark' });

	const query = session.db.select().from(users).all();
	const method = session.client.listPosts();
	await Promise.resolve();

	expect(queryRequests).toHaveLength(1);
	expect(methodRequests).toHaveLength(0);

	releaseQuery();
	await expect(query).resolves.toEqual([{ id: 1 }]);
	await expect(method).resolves.toBe('posts');
	expect(methodRequests[0]).toEqual({
		method: 'listPosts',
		args: [],
		bookmark: 'query-bookmark',
	});
	expect(session.getBookmark()).toBe('method-bookmark');
});
