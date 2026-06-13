import { createD1ObjectRemoteDatabase, type DrizzleD1ObjectRemoteDatabase } from './remote.ts';
import type {
	D1ObjectMethodRequest,
	D1ObjectMethodResponse,
	D1ObjectQueryRequest,
	D1ObjectQueryResponse,
	D1ObjectRemoteDrizzleConfig,
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
	readonly db: DrizzleD1ObjectRemoteDatabase<TSchema>;
	readonly bookmark: string | undefined;
	getBookmark(): string | undefined;
	setBookmark(bookmark: string | null | undefined): void;
}

export function createD1ObjectSession<
	TObject extends object,
	TSchema extends Record<string, unknown> = Record<string, never>,
>(
	stub: D1ObjectSessionStub,
	options: D1ObjectSessionOptions<TSchema> = {},
): D1ObjectSession<TObject, TSchema> {
	let bookmark = options.bookmark ?? undefined;
	let pending = Promise.resolve();

	const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
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

	const db = createD1ObjectRemoteDatabase(stub, {
		getBookmark() {
			return bookmark;
		},
		setBookmark(nextBookmark) {
			bookmark = nextBookmark ?? undefined;
		},
		enqueue,
	}, options);

	return {
		client,
		db,
		get bookmark() {
			return bookmark;
		},
		getBookmark() {
			return bookmark;
		},
		setBookmark(nextBookmark) {
			bookmark = nextBookmark ?? undefined;
		},
	};
}
