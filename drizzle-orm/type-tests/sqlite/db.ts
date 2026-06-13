import Database from 'better-sqlite3';
import { Database as BunDatabase } from 'bun:sqlite';
import { type Equal, Expect } from 'type-tests/utils.ts';
import { drizzle as drizzleBetterSqlite3 } from '~/better-sqlite3/index.ts';
import { drizzle as drizzleBun } from '~/bun-sqlite/index.ts';
import {
	createD1ObjectSession,
	drizzle as drizzleD1Object,
	DrizzleD1Object,
	setupD1Object,
} from '~/d1-object/index.ts';
import { drizzle as drizzleD1 } from '~/d1/index.ts';
import { drizzle as durableSqlite } from '~/durable-sqlite/index.ts';

const client = new Database(':memory:');
const bunClient = new BunDatabase(':memory:');
declare const d1: D1Database;
declare const durableSql: DurableObjectStorage;
declare const durableObjectState: DurableObjectState;
declare const durableObjectEnv: Record<string, never>;

export const db = drizzleBetterSqlite3(client);
export const bunDb = drizzleBun(bunClient);
export const d1Db = drizzleD1(d1);
export const durableSqliteDb = durableSqlite(durableSql);
export const d1ObjectDb = drizzleD1Object(durableObjectState);

setupD1Object(durableObjectState);

export class TestD1Object extends DrizzleD1Object<typeof durableObjectEnv> {
	db = drizzleD1Object(this.ctx);

	async listPosts(limit: number) {
		return [{ id: limit }];
	}
}

const d1ObjectSession = createD1ObjectSession<TestD1Object>({
	runDrizzleObjectMethod: async () => ({ value: [], bookmark: 'bookmark' }),
});

Expect<Equal<ReturnType<typeof d1ObjectSession.client.listPosts>, Promise<{ id: number }[]>>>();
