import { createD1ObjectRemoteDatabase, type DrizzleD1ObjectRemoteDatabase } from './remote.ts';
import type {
	D1ObjectBookmarkResponse,
	D1ObjectMethodRequest,
	D1ObjectMethodResponse,
	D1ObjectQueryRequest,
	D1ObjectQueryResponse,
	D1ObjectRemoteDrizzleConfig,
	D1ObjectSessionRequest,
	D1ObjectSetBookmarkRequest,
} from './types.ts';

type AnyMethod = (...args: any[]) => any;
type D1ObjectReservedMethod =
	| 'runDrizzleObjectMethod'
	| 'runDrizzleQuery'
	| 'applyDrizzleMigrations';

type D1ObjectMethodKey<TObject> = {
	[K in keyof TObject]: K extends D1ObjectReservedMethod ? never : TObject[K] extends AnyMethod ? K : never;
}[keyof TObject];

export type D1ObjectSessionClient<TObject extends object> = {
	[K in D1ObjectMethodKey<TObject>]: TObject[K] extends (...args: infer TArgs) => infer TResult
		? (...args: TArgs) => Promise<Awaited<TResult>>
		: never;
};

export interface D1ObjectSessionStub {
	runDrizzleObjectMethod(request: D1ObjectMethodRequest): Promise<D1ObjectMethodResponse>;
	runDrizzleQuery?(request: D1ObjectQueryRequest): Promise<D1ObjectQueryResponse>;
	createDrizzleSession?(request: D1ObjectSessionRequest): D1ObjectRemoteSessionStub;
}

export interface D1ObjectRemoteSessionStub {
	runDrizzleObjectMethod(request: D1ObjectMethodRequest): Promise<D1ObjectMethodResponse>;
	runDrizzleQuery(request: D1ObjectQueryRequest): Promise<D1ObjectQueryResponse>;
	setBookmark?(request: D1ObjectSetBookmarkRequest): Promise<D1ObjectBookmarkResponse>;
}

export interface D1ObjectSessionOptions<TSchema extends Record<string, unknown> = Record<string, never>>
	extends D1ObjectRemoteDrizzleConfig<TSchema>
{
	bookmark?: string | null;
}

export interface D1ObjectSession<
	TObject extends object,
	TSchema extends Record<string, unknown> = Record<string, never>,
> {
	readonly client: D1ObjectSessionClient<TObject>;
	readonly db: DrizzleD1ObjectSessionDatabase<TObject, TSchema>;
	readonly bookmark: string | undefined;
	getBookmark(): string | undefined;
	setBookmark(bookmark: string | null | undefined): void;
}

export interface D1ObjectSessionHelpers<TObject extends object> {
	readonly client: D1ObjectSessionClient<TObject>;
	readonly bookmark: string | undefined;
	getBookmark(): string | undefined;
	setBookmark(bookmark: string | null | undefined): void;
}

export type DrizzleD1ObjectSessionDatabase<
	TObject extends object,
	TSchema extends Record<string, unknown> = Record<string, never>,
	TClient extends D1ObjectSessionStub = D1ObjectSessionStub,
> = DrizzleD1ObjectRemoteDatabase<TSchema> & {
	readonly $client: TClient;
	readonly d1: D1ObjectSessionHelpers<TObject>;
};

export function createD1ObjectSession<
	TObject extends object,
	TSchema extends Record<string, unknown> = Record<string, never>,
>(
	stub: D1ObjectSessionStub,
	options: D1ObjectSessionOptions<TSchema> = {},
): D1ObjectSession<TObject, TSchema> {
	const db = createD1ObjectSessionDatabase<TObject, TSchema>(stub, options);

	return {
		client: db.d1.client,
		db,
		get bookmark() {
			return db.d1.bookmark;
		},
		getBookmark() {
			return db.d1.getBookmark();
		},
		setBookmark(bookmark) {
			db.d1.setBookmark(bookmark);
		},
	};
}

/** @internal */
export function createD1ObjectSessionDatabase<
	TObject extends object,
	TSchema extends Record<string, unknown> = Record<string, never>,
	TClient extends D1ObjectSessionStub = D1ObjectSessionStub,
>(
	stub: TClient,
	options: D1ObjectSessionOptions<TSchema> = {},
): DrizzleD1ObjectSessionDatabase<TObject, TSchema, TClient> {
	let bookmark = options.bookmark ?? undefined;
	let pending = Promise.resolve();
	let sequence = 0;
	const remoteSession = stub.createDrizzleSession?.({ bookmark });
	const nextSequence = () => remoteSession === undefined ? undefined : ++sequence;

	const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
		if (remoteSession !== undefined) {
			return operation();
		}

		const call = pending.then(operation);
		pending = call.then(
			() => undefined,
			() => undefined,
		);
		return call;
	};

	const client = new Proxy(Object.create(null), {
		get(_target, property) {
			if (typeof property !== 'string' || property === 'then') {
				return undefined;
			}

			return (...args: unknown[]) => {
				if (remoteSession !== undefined) {
					return remoteSession.runDrizzleObjectMethod({
						method: property,
						args,
						sequence: nextSequence(),
					}).then((response) => {
						bookmark = response.bookmark;
						return response.value;
					});
				}

				return enqueue(async () => {
					const response = await stub.runDrizzleObjectMethod({
						method: property,
						args,
						bookmark,
					});
					bookmark = response.bookmark;
					return response.value;
				});
			};
		},
	}) as D1ObjectSessionClient<TObject>;

	const db = createD1ObjectRemoteDatabase(remoteSession ?? stub, {
		getBookmark() {
			return remoteSession === undefined ? bookmark : undefined;
		},
		setBookmark(nextBookmark) {
			bookmark = nextBookmark ?? undefined;
		},
		getSequence: nextSequence,
		enqueue,
	}, options);

	const d1: D1ObjectSessionHelpers<TObject> = {
		client,
		get bookmark() {
			return bookmark;
		},
		getBookmark() {
			return bookmark;
		},
		setBookmark(nextBookmark) {
			bookmark = nextBookmark ?? undefined;
			if (remoteSession?.setBookmark) {
				void remoteSession.setBookmark({
					bookmark,
					sequence: nextSequence(),
				}).then((response) => {
					bookmark = response.bookmark;
				}, () => undefined);
			}
		},
	};

	(<any> db).d1 = d1;

	return db as DrizzleD1ObjectSessionDatabase<TObject, TSchema, TClient>;
}
