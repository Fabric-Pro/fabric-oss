/**
 * Activity wrapper that tags every log line an activity emits with its
 * organization id (security review of Fizzy #1234 — telemetry enrichment).
 *
 * The shared logger stamps `organizationId` from AsyncLocalStorage onto each
 * entry (see @repo/logs), and the bug-analysis log predicate filters
 * `Properties["organizationId"]` — so an activity wrapped here produces rows
 * the org-scoped query can actually match. Worker-side only: wrapping at the
 * barrel never touches workflow code, so replay determinism is unaffected.
 */
import { runWithOrganizationLogContext } from "@repo/utils/organization-log-context";

const wrappedActivities = new WeakMap<object, object>();

/** Follow declared activity wrappers to their original implementation. */
export function unwrapActivity(fn: object): object {
	let current = fn;
	let wrapped = wrappedActivities.get(current);
	while (wrapped) {
		current = wrapped;
		wrapped = wrappedActivities.get(current);
	}
	return current;
}

type WithOrganizationId = { organizationId?: string | null };

export function withOrganizationLogContext<Args, R>(
	fn: (args: Args) => Promise<R>,
): (args: Args & WithOrganizationId) => Promise<R> {
	const wrapped = (args: Args & WithOrganizationId) =>
		runWithOrganizationLogContext(args.organizationId, () => fn(args));
	wrappedActivities.set(wrapped, fn);
	return wrapped;
}
