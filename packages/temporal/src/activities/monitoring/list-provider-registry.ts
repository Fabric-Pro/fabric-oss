/**
 * listProviderRegistry activity.
 *
 * Returns the in-memory registry of integration providers as a
 * serializable list of registration objects, with only the fields the
 * workflow needs. Trimmed to keep the Temporal history payload small.
 *
 * Lives as an activity (not inline in the workflow) because:
 *   1. The registry is in-memory (module-scoped Map), so reading it is
 *      a non-deterministic side effect from the workflow's POV.
 *   2. The set of providers can change between worker restarts — the
 *      workflow must always re-read it on every poll iteration to pick
 *      up newly registered providers without needing a code redeploy.
 */
import {
	getProvidersForPolling,
	getProvidersForSyntheticProbe,
	getRegistration,
	listRegistrations,
} from "@repo/observability";

/**
 * Workflow-side view of the synthetic probe config.
 *
 * Carries only the fields the workflow actually needs to drive the
 * generic `runSyntheticProbe` activity. The HTTP / SDK execution
 * details (url, headers, expectedStatus, clientProbeFn) stay inside
 * the activity — the workflow only needs the probe interval for
 * scheduling decisions.
 */
export interface ProviderRegistrySyntheticProbe {
	interval: string;
}

export interface ProviderRegistrySerializable {
	key: string;
	displayName: string;
	statusPageUrl?: string;
	statusPageApiUrl?: string;
	statusPagePolling?: boolean;
	/**
	 * Non-default status-page parser. The workflow forwards this to
	 * `pollStatusPage` so the activity can dispatch to the matching
	 * non-Atlassian decoder. Unset → activity uses the Atlassian default.
	 */
	customParser?:
		| "google-workspace"
		| "google-cloud"
		| "slack"
		| "status-io"
		| "zendesk-ssp"
		| "salesforce";
	/** Optional narrow filter passed to the `google-workspace` parser. */
	googleWorkspaceServiceName?: string;
	/** Optional narrow filter passed to the `google-cloud` parser. */
	googleCloudProductTitle?: string;
	/** Optional narrow filter passed to the `zendesk-ssp` parser. */
	zendeskServiceSlug?: string;
	/**
	 * Atlassian Statuspage component-name allow-list passed straight to
	 * `pollStatusPage`. Lets multi-component providers (e.g. Cloudflare
	 * R2) ignore unrelated incidents (e.g. Cloudflare Billing).
	 */
	statusPageComponents?: string[];
	/**
	 * Tooltip-ready explanation surfaced when `statusPagePolling: false`.
	 * Wired through for the admin monitoring UI tooltip on UNKNOWN cards.
	 */
	statusUnsupportedReason?: string;
	syntheticProbe?: ProviderRegistrySyntheticProbe;
	breakerKey?: string;
	affectedFeatures: string[];
	dataConnectionProvider?: string;
}

export interface ListProviderRegistryInput {
	/**
	 * Filter to apply:
	 *   - `polling`   → only providers with summary.json endpoint enabled.
	 *   - `synthetic` → only MVP-5 providers (have `syntheticProbe`).
	 *   - `all`       → unfiltered.
	 */
	filter: "polling" | "synthetic" | "all";
}

export async function listProviderRegistry(
	input: ListProviderRegistryInput,
): Promise<ProviderRegistrySerializable[]> {
	let regs: ReturnType<typeof listRegistrations>;
	switch (input.filter) {
		case "polling":
			regs = getProvidersForPolling();
			break;
		case "synthetic":
			regs = getProvidersForSyntheticProbe();
			break;
		default:
			regs = listRegistrations();
			break;
	}
	return regs.map(toSerializable);
}

export interface GetProviderRegistrationInput {
	providerKey: string;
}

/**
 * Lookup a single provider registration by key. Used by per-provider
 * cron workflows that store only the key in their workflow state.
 */
export async function getProviderRegistration(
	input: GetProviderRegistrationInput,
): Promise<ProviderRegistrySerializable | null> {
	const reg = getRegistration(input.providerKey);
	return reg ? toSerializable(reg) : null;
}

function toSerializable(
	reg: ReturnType<typeof listRegistrations>[number],
): ProviderRegistrySerializable {
	return {
		key: reg.key,
		displayName: reg.displayName,
		statusPageUrl: reg.statusPageUrl,
		statusPageApiUrl: reg.statusPageApiUrl,
		statusPagePolling: reg.statusPagePolling,
		customParser: reg.customParser,
		googleWorkspaceServiceName: reg.googleWorkspaceServiceName,
		googleCloudProductTitle: reg.googleCloudProductTitle,
		zendeskServiceSlug: reg.zendeskServiceSlug,
		// CRITICAL: forward the statuspage component allow-list so multi-
		// component pages (Cloudflare → R2 only) actually filter unrelated
		// incidents. Omitting this here caused the poll workflow to call
		// `pollStatusPage` with `statusPageComponents=undefined` for every
		// provider, which collapsed to "no filter, surface all incidents".
		// That's why "PayPal Billing Issues" showed up under Cloudflare R2.
		statusPageComponents: reg.statusPageComponents
			? [...reg.statusPageComponents]
			: undefined,
		statusUnsupportedReason: reg.statusUnsupportedReason,
		// Project only the workflow-relevant fields — the HTTP / SDK
		// probe details stay inside the activity.
		syntheticProbe: reg.syntheticProbe
			? { interval: reg.syntheticProbe.interval }
			: undefined,
		breakerKey: reg.breakerKey,
		affectedFeatures: [...reg.affectedFeatures],
		dataConnectionProvider: reg.dataConnectionProvider,
	};
}
