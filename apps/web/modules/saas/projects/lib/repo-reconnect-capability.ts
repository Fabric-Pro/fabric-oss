/**
 * Which repository providers Fabric can actually RECONNECT in-app.
 *
 * Reconnect is an OAuth round trip, so it exists only for the OAuth-backed
 * providers. Azure DevOps integrations are PAT-based: there is no reconnect
 * action anywhere in the product for them, and `ProjectRepositoryIntegration
 * Settings.tsx` has always suppressed its inline "Reconnect" control
 * accordingly.
 *
 * This module exists so that gate has ONE definition. The QA-tab sync-failure
 * banner offered a "Reconnect" call-to-action on any failure whose classified
 * kind said reconnecting was the fix — which is provider-agnostic — so an Azure
 * DevOps PAT failure got a CTA pointing at a settings page with no Azure DevOps
 * reconnect action on it. "Reconnecting fixes this KIND of failure" and
 * "reconnect is available for this PROVIDER" are two independent conditions and
 * both have to hold before a CTA is offered.
 *
 * Two vocabularies, one table: the settings page holds a
 * `RepositoryProvider` enum value from the integration row, while the QA
 * freshness view holds the `TestPipelineSyncState.provider` TAG (the sync
 * activity's `PROVIDER_TAG`). They are given separate predicates over a single
 * pair list rather than a conversion helper, so neither caller has to translate
 * and the two can never disagree about which providers are reconnectable.
 */

const RECONNECTABLE_PROVIDERS = [
	{ provider: "GITHUB", syncProviderTag: "github-actions" },
	{ provider: "GITLAB", syncProviderTag: "gitlab-ci" },
] as const;

const RECONNECTABLE_PROVIDER_VALUES: ReadonlySet<string> = new Set(
	RECONNECTABLE_PROVIDERS.map((p) => p.provider),
);

const RECONNECTABLE_SYNC_PROVIDER_TAGS: ReadonlySet<string> = new Set(
	RECONNECTABLE_PROVIDERS.map((p) => p.syncProviderTag),
);

/**
 * Does this `RepositoryProvider` (the integration row's own enum value) have
 * an in-app reconnect flow?
 */
export function repositoryProviderSupportsReconnect(
	provider: string | null | undefined,
): boolean {
	return provider != null && RECONNECTABLE_PROVIDER_VALUES.has(provider);
}

/**
 * Same question, asked with a `TestPipelineSyncState.provider` tag —
 * `"github-actions"` / `"gitlab-ci"` / `"azure-devops"` — which is the only
 * provider identity the QA freshness view has. An unrecognized tag answers
 * false: a CTA that cannot be honoured is worse than no CTA.
 */
export function syncProviderSupportsReconnect(
	providerTag: string | null | undefined,
): boolean {
	return (
		providerTag != null && RECONNECTABLE_SYNC_PROVIDER_TAGS.has(providerTag)
	);
}
