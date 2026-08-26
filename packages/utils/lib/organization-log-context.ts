/**
 * Organization context for log enrichment.
 *
 * Mirrors correlation-id.ts: an AsyncLocalStorage carried organization id
 * that the shared logger stamps onto every entry, so tenant-scoped log
 * queries (e.g. the bug-analysis log predicate,
 * `Properties["organizationId"] == "<org>"`) match the rows an analysis
 * actually produced.
 *
 * Activities wrap their body in `runWithOrganizationLogContext` when their
 * input carries the organization; everything logged inside — including
 * helper functions and dependencies — is tagged without per-call edits.
 *
 * Uses globalThis to guarantee a single AsyncLocalStorage instance even
 * when the bundler creates multiple copies of this module across different
 * package bundles (same rationale as correlation-id.ts).
 */
import { AsyncLocalStorage } from "node:async_hooks";

const GLOBAL_KEY = "__fabric_organization_log_storage__" as const;

export const organizationLogStorage: AsyncLocalStorage<string> =
	((globalThis as Record<string, unknown>)[GLOBAL_KEY] as
		| AsyncLocalStorage<string>
		| undefined) ??
	(() => {
		const storage = new AsyncLocalStorage<string>();
		(globalThis as Record<string, unknown>)[GLOBAL_KEY] = storage;
		return storage;
	})();

/**
 * Get the organization id from AsyncLocalStorage.
 * Returns undefined when not running inside an organization log context.
 */
export function getOrganizationIdFromLogContext(): string | undefined {
	return organizationLogStorage.getStore();
}

/**
 * Run a function with an organization id in async log context.
 * A falsy id runs the function without changing context (personal-context
 * work has no organization to tag).
 */
export function runWithOrganizationLogContext<T>(
	organizationId: string | null | undefined,
	fn: () => T,
): T {
	if (!organizationId) {
		return fn();
	}
	return organizationLogStorage.run(organizationId, fn);
}
