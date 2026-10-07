/**
 * Better Auth starts its async plugin initialization when its factory is called.
 * Keep imports database-free, like the Prisma singleton, and construct the native
 * instance on first property access by a request or an explicit context consumer.
 * Forward the native API intact so endpoint hooks and types are unchanged.
 */
export function createLazyAuth<T extends object>(factory: () => T): T {
	let initialized: { value: T } | { error: unknown } | undefined;
	const instance = (): T => {
		if (!initialized) {
			try {
				initialized = { value: factory() };
			} catch (error) {
				initialized = { error };
			}
		}
		// Cache synchronous factory failures too. Async initialization failures stay
		// on the native instance's $context promise and reach every API/handler caller.
		if ("error" in initialized) {
			throw initialized.error;
		}
		return initialized.value;
	};
	return new Proxy({} as T, {
		get(_target, property) {
			return Reflect.get(instance(), property);
		},
		has(_target, property) {
			return Reflect.has(instance(), property);
		},
		ownKeys() {
			return Reflect.ownKeys(instance());
		},
		getOwnPropertyDescriptor(_target, property) {
			const descriptor = Reflect.getOwnPropertyDescriptor(
				instance(),
				property,
			);
			return descriptor
				? { ...descriptor, configurable: true }
				: undefined;
		},
	});
}
