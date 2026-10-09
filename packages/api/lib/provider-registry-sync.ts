import { syncIntegrationProviderRegistry } from "@repo/database";
import { logger } from "@repo/logs";
import { getRegisteredProviders } from "@repo/observability";
import { waitUntil } from "@vercel/functions";

let scheduled = false;

/**
 * Provider registry sync: mirrors the in-memory integration-provider registry
 * into the DB once per process. Fire-and-forget — the sync function swallows
 * errors internally and logs so a transient DB blip never blocks the API from
 * serving traffic. Skipped during unit tests (or with an explicit opt-out) so
 * test runs do not require Postgres to be reachable.
 *
 * Called after the first request has been handled, not at import: the sync is
 * a DB round trip that the first request of a cold instance does not need to
 * wait behind or compete with for the connection.
 *
 * The registry data lives in `@repo/observability`; the DB sync helper lives
 * in `@repo/database`. We bridge them here so neither package has to depend on
 * the other (avoids the cycle `observability → database → storage →
 * observability`).
 */
export function syncProviderRegistryOnce(): void {
	if (scheduled) {
		return;
	}
	scheduled = true;
	if (
		process.env.NODE_ENV === "test" ||
		process.env.SKIP_PROVIDER_REGISTRY_SYNC === "1"
	) {
		return;
	}
	waitUntil(
		syncIntegrationProviderRegistry(getRegisteredProviders()).catch(
			(err) => {
				logger.error(
					"[API] Failed to sync integration provider registry:",
					err,
				);
			},
		),
	);
}
