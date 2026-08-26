/**
 * Ambient project context for cross-package use.
 *
 * The read-only-mode write-gate needs to know which project a write belongs to.
 * Threading `projectId` through every call site is fragile — a new feature (or
 * a route like the MCP-App proxy) forgets, and the write escapes. Instead we
 * carry the active project's id in AsyncLocalStorage, set once at each
 * project-scoped entry point (oRPC project middleware, the Temporal activity
 * interceptor, the MCP-App route handlers), so the low-level dispatch funnel can
 * read it with no per-call-site work — current AND future paths.
 *
 * Uses globalThis to guarantee a single AsyncLocalStorage instance even when
 * the bundler (Next.js/Turbopack) creates multiple copies of this module across
 * package bundles — same rationale as {@link correlationStorage}.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const GLOBAL_KEY = "__fabric_project_context_storage__" as const;

export const projectContextStorage: AsyncLocalStorage<string> =
	((globalThis as Record<string, unknown>)[GLOBAL_KEY] as
		| AsyncLocalStorage<string>
		| undefined) ??
	(() => {
		const storage = new AsyncLocalStorage<string>();
		(globalThis as Record<string, unknown>)[GLOBAL_KEY] = storage;
		return storage;
	})();

/** The active project id, or undefined outside a project-scoped context. */
export function getAmbientProjectId(): string | undefined {
	return projectContextStorage.getStore();
}

/**
 * Run a function with a project id in async context. A falsy id runs `fn`
 * with no context set (so an org-level operation doesn't inherit a stale id).
 */
export function runWithProjectContext<T>(
	projectId: string | undefined | null,
	fn: () => T,
): T {
	if (!projectId) {
		return fn();
	}
	return projectContextStorage.run(projectId, fn);
}
