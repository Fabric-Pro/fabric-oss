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

type WithOrganizationId = { organizationId?: string | null };

export function withOrganizationLogContext<Args, R>(
	fn: (args: Args) => Promise<R>,
): (args: Args & WithOrganizationId) => Promise<R> {
	return (args) =>
		runWithOrganizationLogContext(args.organizationId, () => fn(args));
}
