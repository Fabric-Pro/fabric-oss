/**
 * Stand-in for `@shared/lib/orpc-query-utils` in spike tests. The real
 * `createTanstackQueryUtils` walks the (mocked, partial) client and returns
 * `undefined` for procedures the mock does not define, so `.key()` /
 * `.queryKey()` / `.queryOptions()` would throw. This proxy answers any path.
 */
type AnyRecord = Record<string, unknown>;

function makeNode(path: string[]): AnyRecord {
	return new Proxy(
		{},
		{
			get(_target, prop: string | symbol) {
				if (typeof prop !== "string") {
					return undefined;
				}
				if (prop === "key") {
					return () => [path];
				}
				if (prop === "queryKey") {
					return (options?: AnyRecord) => [path, options ?? {}];
				}
				if (prop === "queryOptions") {
					return (options?: AnyRecord) => ({
						queryKey: [path, options ?? {}],
						queryFn: async () => [],
					});
				}
				return makeNode([...path, prop]);
			},
		},
	);
}

export function orpcQueryMock() {
	return { orpc: makeNode([]) };
}
