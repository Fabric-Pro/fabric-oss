// Portions of this file are derived from Corsair (https://github.com/corsairdotdev/corsair)
// Original work © Corsair contributors. Licensed under Apache-2.0.
// Modifications © TechFabric LLC. Licensed under MIT (see the containing package's LICENSE).
// See THIRD_PARTY_NOTICES.md at the repository root for full attribution.

/**
 * Core types for Fabric integrations: endpoints, plugins, permissions, webhooks.
 *
 * Design choices vs. Corsair:
 *   - Endpoints are a flat dot-notation map (`messages.send`) rather than a deeply
 *     nested generic tree. Plugin authors can still organize source files
 *     hierarchically; the runtime just sees a flat registry.
 *   - Credentials and approvals are resolved through injectable stores rather than
 *     a built-in Kysely-backed database. The portal's existing connector store
 *     plugs in via `CredentialStore`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Permission system (lifted from Corsair, see THIRD_PARTY_NOTICES.md)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Risk classification for a single endpoint. Drives the default permission policy
 * given the active permission mode.
 */
export type EndpointRiskLevel = "read" | "write" | "destructive";

/**
 * Permission mode controlling what an external agent is allowed to do by default.
 *
 * | mode     | read  | write            | destructive         |
 * |----------|-------|------------------|---------------------|
 * | open     | allow | allow            | allow               |
 * | cautious | allow | allow            | require_approval    |
 * | strict   | allow | require_approval | deny                |
 * | readonly | allow | deny             | deny                |
 */
export type PermissionMode = "open" | "cautious" | "strict" | "readonly";

/**
 * The resolved policy for a specific endpoint after combining mode + overrides.
 *  - `allow`            → executes immediately
 *  - `deny`             → returns a denied result, does not call the upstream API
 *  - `require_approval` → enqueues a pending approval, surfaces an approval handle
 */
export type PermissionPolicy = "allow" | "deny" | "require_approval";

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint and plugin shape
// ─────────────────────────────────────────────────────────────────────────────

/** Metadata for a single endpoint. Drives permission decisions and tool descriptions. */
export interface EndpointMeta {
	/** Risk classification — combined with the active mode to derive the default policy. */
	riskLevel: EndpointRiskLevel;
	/** True if the action cannot be undone. Surfaced prominently on approval prompts. */
	irreversible?: boolean;
	/** Human-readable description shown to agents and on approval prompts. */
	description?: string;
}

/** Context passed to every endpoint handler at execution time. */
export interface IntegrationContext {
	/** Slug of the plugin this call is targeting (e.g. `"slack"`). */
	pluginSlug: string;
	/** The dot-notation endpoint path (e.g. `"messages.send"`). */
	endpoint: string;
	/** Tenant identifier — opaque string the credential store understands (workspace id, org id, etc.). */
	tenantId: string;
	/** Resolved credentials supplied by the credential store. Shape is plugin-specific. */
	credentials: Record<string, unknown>;
	/** AbortSignal forwarded from the executor for cancellation. */
	signal?: AbortSignal;
}

/** A single endpoint handler. Receives bound context + caller args, returns the API response. */
export type EndpointHandler<Args = unknown, Result = unknown> = (
	ctx: IntegrationContext,
	args: Args,
) => Promise<Result>;

/** Endpoint definition: handler + metadata. */
export interface EndpointDefinition<Args = unknown, Result = unknown> {
	handler: EndpointHandler<Args, Result>;
	meta: EndpointMeta;
}

/**
 * Webhook signature verification result.
 *  - `valid`   → payload is authentic; pass to handler
 *  - `invalid` → discard, return 401
 *  - `unknown` → no verifier registered; behavior controlled by processor policy
 */
export type SignatureVerificationResult = "valid" | "invalid" | "unknown";

/**
 * Verifies an inbound webhook request originated from the upstream vendor.
 * Implementations typically compare HMAC headers against a per-tenant secret.
 */
export type WebhookSignatureVerifier = (req: {
	headers: Record<string, string>;
	rawBody: string | Uint8Array;
	tenantId?: string;
	credentials?: Record<string, unknown>;
}) => Promise<SignatureVerificationResult> | SignatureVerificationResult;

/** Webhook event handler. Receives the parsed payload and returns an optional response. */
export type WebhookHandler<Payload = unknown, Response = unknown> = (
	ctx: IntegrationContext,
	payload: Payload,
) => Promise<Response | undefined> | Response | undefined;

export interface WebhookDefinition<Payload = unknown, Response = unknown> {
	/** Identifies which webhook event this handler matches (e.g. `"issues.opened"`). */
	matcher: (payload: unknown, headers: Record<string, string>) => boolean;
	handler: WebhookHandler<Payload, Response>;
}

/**
 * OAuth configuration shape. Only the *config* lives here; the actual flow
 * implementation is a portal concern (we already have a connector store that
 * runs OAuth flows). Plugins declare what they need; the portal honors it.
 */
export interface OAuthConfig {
	type: "oauth2" | "oauth1";
	authorizationUrl?: string;
	tokenUrl?: string;
	scopes?: readonly string[];
	/** Plugin-specific extras the portal's OAuth handler may need (e.g. PKCE). */
	extras?: Record<string, unknown>;
}

/** Plugin-level permission configuration. */
export interface PluginPermissionsConfig {
	/** Default mode applied to every endpoint of this plugin. */
	mode: PermissionMode;
	/** Per-endpoint overrides keyed by dot-notation endpoint path. */
	overrides?: Record<string, PermissionPolicy>;
}

/**
 * A fully-defined integration plugin. One per vendor. Registered with the runtime
 * registry; the plugin slug is the unique identifier callers use.
 */
export interface IntegrationPlugin {
	/** Stable slug, lowercase (e.g. `"slack"`, `"github"`). Becomes the call-site key. */
	slug: string;
	/** Human-readable name for UI. */
	name: string;
	/** Optional package version of the plugin (for telemetry / debugging). */
	version?: string;
	/**
	 * Flat map of endpoint paths → endpoint definitions.
	 *
	 * Stored as `EndpointDefinition<any, any>` so plugin authors can supply
	 * specifically-typed handlers without TypeScript variance complaints.
	 * The handlers themselves still enforce their own arg / return types when
	 * invoked through the typed surface.
	 */
	endpoints: Record<string, EndpointDefinition<any, any>>;
	/** Default permissions config; tenant-level overrides may further refine. */
	permissions?: PluginPermissionsConfig;
	/** OAuth declaration (if this plugin uses OAuth). */
	oauth?: OAuthConfig;
	/** Optional webhook definitions, keyed by dot-notation event path. */
	webhooks?: Record<string, WebhookDefinition>;
	/** Optional signature verifier for inbound webhooks. */
	verifyWebhookSignature?: WebhookSignatureVerifier;
}

// ─────────────────────────────────────────────────────────────────────────────
// Injectable stores
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves credentials for a (tenantId, pluginSlug) pair. The portal's existing
 * connector store implements this; tests use the in-memory implementation.
 */
export interface CredentialStore {
	get(
		tenantId: string,
		pluginSlug: string,
	): Promise<Record<string, unknown> | undefined>;
}

/** A pending approval awaiting a human decision. */
export interface PendingApproval {
	id: string;
	tenantId: string;
	pluginSlug: string;
	endpoint: string;
	args: unknown;
	riskLevel: EndpointRiskLevel;
	policy: Extract<PermissionPolicy, "require_approval">;
	createdAt: string;
	expiresAt: string;
	status: "pending" | "approved" | "denied" | "expired";
}

/**
 * Stores pending approvals so the portal's UI can surface them and route the
 * decision back to the executor.
 */
export interface ApprovalStore {
	create(
		input: Omit<PendingApproval, "id" | "createdAt" | "status"> & {
			id?: string;
			createdAt?: string;
		},
	): Promise<PendingApproval>;
	get(id: string): Promise<PendingApproval | undefined>;
	resolve(
		id: string,
		decision: "approved" | "denied",
	): Promise<PendingApproval | undefined>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Executor result envelope
// ─────────────────────────────────────────────────────────────────────────────

/** Result returned by `IntegrationExecutor.call`. */
export type ExecuteResult<T = unknown> =
	| { status: "ok"; data: T }
	| {
			status: "pending_approval";
			approvalId: string;
			expiresAt: string;
			riskLevel: EndpointRiskLevel;
	  }
	| { status: "denied"; reason: string };
