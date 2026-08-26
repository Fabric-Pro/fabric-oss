/**
 * Correlation ID primitives for cross-package use.
 *
 * These are extracted from @repo/api so that packages like @repo/mail
 * can resolve correlation IDs without depending on the API package.
 *
 * Uses globalThis to guarantee a single AsyncLocalStorage instance even
 * when the bundler (Next.js/Turbopack) creates multiple copies of this
 * module across different package bundles.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const GLOBAL_KEY = "__fabric_correlation_storage__" as const;

/**
 * Shared AsyncLocalStorage instance for correlation ID propagation.
 * Stored on globalThis so all bundled copies share one instance.
 */
export const correlationStorage: AsyncLocalStorage<string> =
	((globalThis as Record<string, unknown>)[GLOBAL_KEY] as
		| AsyncLocalStorage<string>
		| undefined) ??
	(() => {
		const storage = new AsyncLocalStorage<string>();
		(globalThis as Record<string, unknown>)[GLOBAL_KEY] = storage;
		return storage;
	})();

/**
 * Generate a unique correlation ID.
 * Format: req_<timestamp_base36>_<random_base36>
 */
export function generateCorrelationId(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 10);
	return `req_${timestamp}_${random}`;
}

/**
 * Get correlation ID from AsyncLocalStorage.
 * Returns undefined if not running inside a correlation context.
 */
export function getCorrelationIdFromContext(): string | undefined {
	return correlationStorage.getStore();
}

/**
 * Run a function with a correlation ID in async context.
 */
export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
	return correlationStorage.run(correlationId, fn);
}
