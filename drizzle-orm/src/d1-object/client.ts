import type { D1ObjectMethodRequest, D1ObjectMethodResponse } from './types.ts';

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
}

export interface D1ObjectSessionOptions {
	bookmark?: string | null;
}

export interface D1ObjectSession<TObject extends object> {
	readonly client: D1ObjectSessionClient<TObject>;
	readonly bookmark: string | undefined;
	getBookmark(): string | undefined;
	setBookmark(bookmark: string | null | undefined): void;
}

export function createD1ObjectSession<TObject extends object>(
	stub: D1ObjectSessionStub,
	options: D1ObjectSessionOptions = {},
): D1ObjectSession<TObject> {
	let bookmark = options.bookmark ?? undefined;
	let pending = Promise.resolve();

	const client = new Proxy(Object.create(null), {
		get(_target, property) {
			if (typeof property !== 'string' || property === 'then') {
				return undefined;
			}

			return (...args: unknown[]) => {
				const call = pending.then(async () => {
					const response = await stub.runDrizzleObjectMethod({
						method: property,
						args,
						bookmark,
					});
					bookmark = response.bookmark;
					return response.value;
				});

				pending = call.then(
					() => undefined,
					() => undefined,
				);

				return call;
			};
		},
	}) as D1ObjectSessionClient<TObject>;

	return {
		client,
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
