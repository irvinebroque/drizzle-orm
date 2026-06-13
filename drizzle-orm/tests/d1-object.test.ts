/// <reference types="@cloudflare/workers-types" />

import { sql } from '~/sql/sql.ts';
import { drizzle } from '~/d1-object/driver.ts';
import { SQLiteD1ObjectSession } from '~/d1-object/session.ts';
import { setupD1Object } from '~/d1-object/setup.ts';
import { SQLiteSyncDialect } from '~/sqlite-core/dialect.ts';
import { expect, test, vi } from 'vitest';

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
} = {}) {
	const calls: { sql: string; params: unknown[] }[] = [];
	const state = {
		primaryStub: options.primaryStub,
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
		},
		blockConcurrencyWhile(callback: () => Promise<unknown>) {
			void callback();
		},
	} as unknown as DurableObjectState & { primaryStub?: unknown };

	return { state, calls };
}

test('setupD1Object configures read replication by default on primary', async () => {
	let configured = false;
	const state = {
		blockConcurrencyWhile(callback: () => Promise<unknown>) {
			return callback();
		},
		configureReadReplication: async () => {
			configured = true;
		},
	} as unknown as DurableObjectState;

	setupD1Object(state);
	await Promise.resolve();

	expect(configured).toBe(true);
});

test('setupD1Object skips read replication when disabled', async () => {
	let configured = false;
	const state = {
		blockConcurrencyWhile(callback: () => Promise<unknown>) {
			return callback();
		},
		configureReadReplication: async () => {
			configured = true;
		},
	} as unknown as DurableObjectState;

	setupD1Object(state, { readReplication: false });
	await Promise.resolve();

	expect(configured).toBe(false);
});

test('raw writes throw on replicas', () => {
	const { state } = createState({ primaryStub: {} });
	const db = drizzle(state);

	expect(() => db.run(sql`insert into users (id) values (1)`)).toThrow('Failed to run the query');
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

test('primary query RPC returns bookmarks for writes', async () => {
	const { state } = createState();
	const { DrizzleD1Object } = await import('~/d1-object/object.ts');
	class TestObject extends DrizzleD1Object<Record<string, never>> {}
	const object = new TestObject(state, {}, { readReplication: false });

	const result = await object.runDrizzleQuery({
		sql: 'insert into users (id) values (?)',
		params: [1],
		method: 'run',
		responseMode: 'object',
		write: true,
	});

	expect(result.bookmark).toBe('bookmark');
});
