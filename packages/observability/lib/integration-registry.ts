/**
 * Integration Provider Registry — TypeScript-side source of truth
 *
 * This module owns the in-memory provider registry. Concrete
 * registrations (MVP-5 + 27 DataConnectionProvider enum values) live in
 * `./integration-providers.ts` and are imported for side effects at boot.
 *
 * Registry rows are mirrored to the `IntegrationProviderRegistry` Prisma
 * model on every Hono boot via
 * `@repo/database`'s `syncIntegrationProviderRegistry(getRegisteredProviders())`
 * (idempotent upsert). Frontend reads health from the DB row — never from
 * this module — so we can keep the registry out of the client bundle.
 *
 * Plug-in pattern: adding a v2 provider is a config-only change — append
 * one `registerIntegrationProvider({...})` call and the boot path picks
 * it up on next restart.
 */

/**
 * Synthetic probe configuration for a registered provider.
 *
 * Two execution shapes are supported:
 *   - **Generic HTTP probe** — set `url` (+ optional `method`, `headers`,
 *     `expectedStatus`, `timeoutMs`, `authHeaderEnvVar`). The generic
 *     `runSyntheticProbe` activity executes a single `fetch` and treats
 *     any matching status as success.
 *   - **Client probe function** — set `clientProbeFn` to one of the
 *     registered probe-function names (currently only `"s3-head-canary"`
 *     for AWS S3). The activity dispatches to a small whitelist of
 *     hand-rolled probe bodies for providers that don't have a clean
 *     HTTP-only liveness endpoint.
 *
 * Exactly ONE of `url` or `clientProbeFn` must be set. The runtime
 * validates this in `runSyntheticProbe` and emits a `timeout`-class
 * failure rather than crashing.
 */
export interface SyntheticProbeConfig {
	/** Cron interval, e.g., `"5m"`. */
	interval: string;

	/**
	 * Probe endpoint URL — used by the generic HTTP path. Should be the
	 * cheapest verifiable read (e.g., `GET /v1/models`, `GET /v1/balance`)
	 * — anything that exercises auth + transport without side-effects.
	 */
	url?: string;

	/** HTTP method for the generic probe. Defaults to `"GET"`. */
	method?: "GET" | "POST" | "HEAD";

	/**
	 * Expected HTTP status codes — any other status counts as failure.
	 * Defaults to `[200]` if omitted. Multiple values supported for
	 * APIs that legitimately return e.g. 200 OR 204.
	 */
	expectedStatus?: number[];

	/**
	 * Static request headers passed to `fetch`. Do NOT include
	 * `Authorization` here — use `authHeaderEnvVar` so the secret
	 * stays out of registry source.
	 */
	headers?: Record<string, string>;

	/**
	 * Name of the env var whose value should be sent as
	 * `Authorization: Bearer <value>`. Optional — providers that don't
	 * need auth (or use a different scheme) can omit. If the env var
	 * is unset at runtime the probe emits a `failure` outcome with
	 * "${envVar} not configured" rather than throwing.
	 */
	authHeaderEnvVar?: string;

	/**
	 * Probe timeout in milliseconds. Defaults to 15_000 (matches the
	 * default in the legacy `runProbe` helper).
	 */
	timeoutMs?: number;

	/**
	 * For providers where a single `fetch` call isn't sufficient
	 * (e.g., AWS S3 needs region+signing via the AWS SDK), specify the
	 * client-probe function name here. The runtime dispatches on
	 * this string to a small whitelist registry of probe bodies.
	 *
	 * Allowed values:
	 *   - `"s3-head-canary"` — HEAD on `AWS_S3_BUCKET` via the S3 SDK.
	 *
	 * Mutually exclusive with `url`. If both are set, `clientProbeFn`
	 * wins so the SDK path is exercised.
	 */
	clientProbeFn?: "s3-head-canary";
}

/**
 * Static configuration for a single integration provider. Registered
 * once at module-load time and never mutated thereafter.
 *
 * `currentHealth` / `lastPolledAt` / `lastIncidentId` are deliberately
 * NOT modelled here — those are runtime state managed by the Temporal
 * pollers and persisted to the DB row. The TS registry is purely
 * static config.
 */
export interface IntegrationProviderRegistration {
	/**
	 * Stable string key — lower-cased, snake_case. Used as the
	 * `provider` label on every Prometheus metric and the unique
	 * `providerKey` column on `IntegrationProviderRegistry`.
	 */
	key: string;

	/** Human-readable name surfaced in the Settings → Integrations UI. */
	displayName: string;

	/**
	 * Public statuspage homepage (rendered in the health-badge tooltip
	 * so admins can click out for vendor detail). Optional — some
	 * providers (e.g., AWS Health) only expose an HTML dashboard.
	 */
	statusPageUrl?: string;

	/**
	 * Public status-page data endpoint. Polled every 2 min by
	 * `statusPagePollerWorkflow`. Leave undefined for providers without
	 * any public status feed (Microsoft 365, Microsoft Teams, Salesforce,
	 * generic S3-compatible).
	 *
	 * Default parser interprets the response as an Atlassian Statuspage
	 * `summary.json` shape. For vendors hosted on incident.io that
	 * preserve the same JSON contract (Notion, Linear, GitBook, Gong) the
	 * default parser works as-is; only the URL changes. Vendors whose
	 * responses differ structurally (Google Workspace / Cloud, Slack,
	 * Zendesk SSP, status.io-hosted pages like GitLab/ClickUp) must also
	 * set `customParser` so the activity dispatches to the matching
	 * non-Atlassian decoder.
	 */
	statusPageApiUrl?: string;

	/**
	 * Selects a non-default parser when the provider's response is NOT
	 * an Atlassian Statuspage `summary.json`. The pollStatusPage activity
	 * dispatches on this discriminator BEFORE falling through to the
	 * default Atlassian path.
	 *
	 *   - `"google-workspace"` — Google Workspace incident-list JSON
	 *     (`https://www.google.com/appsstatus/dashboard/incidents.json`).
	 *     The `googleWorkspaceServiceName` filter narrows the array to
	 *     incidents matching a single product (Gmail, Google Drive, etc.).
	 *   - `"google-cloud"` — Google Cloud incident-list JSON
	 *     (`https://status.cloud.google.com/incidents.json`). Same shape
	 *     as the Workspace feed; `googleCloudProductTitle` narrows to a
	 *     single GCP product (BigQuery, Cloud Storage, etc.).
	 *   - `"slack"` — Slack Status v2 JSON
	 *     (`https://status.slack.com/api/v2.0.0/current`) returning
	 *     `{status, active_incidents: [...]}`.
	 *   - `"status-io"` — status.io 1.0 status JSON
	 *     (`https://api.status.io/1.0/status/<pageId>`) returning
	 *     `{result: {status_overall, status, incidents, maintenance}}`.
	 *     Used by GitLab and ClickUp who self-host their status pages on
	 *     status.io.
	 *   - `"zendesk-ssp"` — Zendesk Status v2 JSON-API
	 *     (`https://status.zendesk.com/api/ssp/incidents.json`).
	 *   - `"salesforce"` — Salesforce Trust v1 active-incidents JSON
	 *     (`https://api.status.salesforce.com/v1/incidents/active`)
	 *     returning a JSON array of currently-active incidents.
	 *
	 * Unset → the activity uses the Atlassian Statuspage parser.
	 */
	customParser?:
		| "google-workspace"
		| "google-cloud"
		| "slack"
		| "status-io"
		| "zendesk-ssp"
		| "salesforce";

	/**
	 * For `customParser: "google-workspace"` only. The exact value of the
	 * incident's `service_name` field that should narrow the result set
	 * (e.g., `"Gmail"`, `"Google Drive"`). Ignored when no custom parser
	 * or a different one is configured.
	 */
	googleWorkspaceServiceName?: string;

	/**
	 * For `customParser: "google-cloud"` only. The exact value of an
	 * `affected_products[].title` entry that should narrow the result set
	 * (e.g., `"Cloud Storage"`, `"BigQuery"`). Ignored when no custom
	 * parser or a different one is configured.
	 */
	googleCloudProductTitle?: string;

	/**
	 * For `customParser: "zendesk-ssp"` only. The exact value of the
	 * Zendesk service `attributes.slug` that should narrow the result set
	 * (e.g., `"support"`). When omitted, an incident affecting ANY
	 * Zendesk service is reflected on this provider. Most Fabric usage
	 * cares about top-level Zendesk health so the default is fine.
	 */
	zendeskServiceSlug?: string;

	/**
	 * Component-name allow-list applied to the Atlassian Statuspage
	 * `summary.json` parser. When set, the parser only treats an incident
	 * as active when at least one of its `incident.components[].name`
	 * entries matches an entry in this list (case-insensitive). When
	 * unset or empty, ALL incidents on the page are considered (current
	 * default behavior).
	 *
	 * Use this for multi-component statuspages where Fabric only cares
	 * about a subset of the provider's surface area. The canonical example
	 * is `status.cloudflarestatus.com/api/v2/summary.json`: it lists
	 * incidents across Workers, R2, Pages, Stream, etc. — without
	 * filtering, a billing incident shows up under "Cloudflare R2" in
	 * the UI, which is misleading.
	 *
	 * Names are matched case-insensitively. Cloudflare component names
	 * shift slightly over time (R2 → "R2 Object Storage" → "R2"), so
	 * register multiple aliases here defensively.
	 *
	 * Only applies to the default Atlassian parser. Custom parsers
	 * (google-workspace, google-cloud, slack, status-io, zendesk-ssp,
	 * salesforce) already have their own per-provider narrowing fields.
	 */
	statusPageComponents?: string[];

	/**
	 * Defaults to `true`. Set to `false` when no public status feed is
	 * available — the UI renders `UNKNOWN` health for those providers and
	 * may surface `statusUnsupportedReason` in a tooltip.
	 */
	statusPagePolling?: boolean;

	/**
	 * Human-readable explanation surfaced by the admin monitoring grid's
	 * UNKNOWN tooltip when `statusPagePolling: false`. Empty/undefined
	 * falls back to the generic "couldn't determine status" copy.
	 *
	 * Set ONLY for genuinely unsupported providers (auth-gated feeds, no
	 * stable public endpoint). Do NOT set when the provider just lacks a
	 * canonical `summary.json` but otherwise exposes parseable data —
	 * write a custom parser instead.
	 *
	 * TODO(ui-agent on fix/admin-monitoring-ux): wire this through the
	 * `listProviderHealth` oRPC response and into the UNKNOWN status
	 * tooltip. Not yet exposed by the DB row; the registry exposes it
	 * via `listProviderRegistry` for future consumers.
	 */
	statusUnsupportedReason?: string;

	/**
	 * Synthetic probe configuration — MVP-5 platform providers only.
	 * Drives the per-provider `syntheticProbeWorkflow` instances via the
	 * generic `runSyntheticProbe` activity (see
	 * `packages/temporal/src/activities/monitoring/synthetic-probe.ts`).
	 * Adding a new probed provider = one registry entry update, no
	 * Temporal code change.
	 */
	syntheticProbe?: SyntheticProbeConfig;

	/**
	 * Cockatiel breaker key — MVP-5 only. Used as the `breaker_key`
	 * label on `provider_breaker_state`. Must be globally unique.
	 */
	breakerKey?: string;

	/**
	 * `FeatureLabel` values whose error-rate alerts should be inhibited
	 * when this provider is OUT. Empty array means provider outage does
	 * not suppress any internal alerts.
	 */
	affectedFeatures: string[];

	/**
	 * When applicable, the raw `DataConnectionProvider` enum string
	 * this entry corresponds to. Used by the registry coverage check
	 * to assert every enum value has exactly one registration.
	 */
	dataConnectionProvider?: string;
}

/**
 * Module-scoped registry. Map keyed by `key` so duplicate registrations
 * fail fast with a clear error (config must be globally unique, no
 * silent overwrites).
 */
const REGISTRY = new Map<string, IntegrationProviderRegistration>();

/**
 * Register one integration provider. Throws if a registration with the
 * same `key` already exists — the registry is append-only at boot, and
 * accidental duplicates would silently shadow earlier entries.
 *
 * Concrete registrations live in `./integration-providers.ts` and are
 * loaded for their side effects at boot. Idempotency on RE-IMPORT
 * (e.g., a test that imports the module twice via different paths) is
 * not provided here — modules are cached by Node so a single import is
 * the norm. If you need a fresh registry in a test, call
 * `__resetRegistryForTests()`.
 */
export function registerIntegrationProvider(
	reg: IntegrationProviderRegistration,
): void {
	if (REGISTRY.has(reg.key)) {
		throw new Error(`Duplicate integration provider key: ${reg.key}`);
	}
	REGISTRY.set(reg.key, cloneRegistration(reg));
}

/**
 * Deep-copy a registration. Spread alone is shallow — the
 * `affectedFeatures` array and the nested `syntheticProbe` object
 * (including `expectedStatus` and `headers`) would still be shared with
 * the caller. We can't rely on `structuredClone` everywhere (Node 20
 * has it, but defensive on runtime variance), so we hand-roll the copy.
 */
function cloneRegistration(
	reg: IntegrationProviderRegistration,
): IntegrationProviderRegistration {
	return {
		...reg,
		affectedFeatures: [...reg.affectedFeatures],
		statusPageComponents: reg.statusPageComponents
			? [...reg.statusPageComponents]
			: undefined,
		syntheticProbe: reg.syntheticProbe
			? {
					...reg.syntheticProbe,
					expectedStatus: reg.syntheticProbe.expectedStatus
						? [...reg.syntheticProbe.expectedStatus]
						: undefined,
					headers: reg.syntheticProbe.headers
						? { ...reg.syntheticProbe.headers }
						: undefined,
				}
			: undefined,
	};
}

/**
 * Snapshot of every registration. Returns defensive (deep) copies so
 * callers cannot mutate the underlying map's stored entries.
 */
export function listRegistrations(): IntegrationProviderRegistration[] {
	return Array.from(REGISTRY.values()).map(cloneRegistration);
}

/**
 * Lookup one registration by key. Returns `undefined` if not present.
 * Returned value is a deep copy so caller mutations cannot leak back
 * into the registry.
 */
export function getRegistration(
	key: string,
): IntegrationProviderRegistration | undefined {
	const entry = REGISTRY.get(key);
	return entry ? cloneRegistration(entry) : undefined;
}

/**
 * Subset of providers that should be polled by the Statuspage cron
 * (`statusPagePollerWorkflow`). Excludes providers explicitly marked
 * `statusPagePolling: false` (no public summary.json) and providers
 * missing `statusPageApiUrl` (can't poll without it).
 */
export function getProvidersForPolling(): IntegrationProviderRegistration[] {
	return listRegistrations().filter(
		(r) => r.statusPagePolling !== false && Boolean(r.statusPageApiUrl),
	);
}

/**
 * Subset of providers that have synthetic probes configured — MVP-5
 * platform providers only. Drives the `syntheticProbeWorkflow` cron.
 */
export function getProvidersForSyntheticProbe(): IntegrationProviderRegistration[] {
	return listRegistrations().filter((r) => r.syntheticProbe !== undefined);
}

/**
 * Test-only hook. The registry is module-scoped and populated at
 * import time, so a test that wants a clean slate (or wants to verify
 * the duplicate-key guard) must reset it explicitly.
 *
 * Not part of the public API surface — kept internal to the package.
 */
export function __resetRegistryForTests(): void {
	REGISTRY.clear();
}
