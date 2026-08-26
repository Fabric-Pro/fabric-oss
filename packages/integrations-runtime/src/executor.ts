import { evaluatePermission, parseDurationMs } from "./permissions.js";
import type { IntegrationRegistry } from "./registry.js";
import type {
	ApprovalStore,
	CredentialStore,
	ExecuteResult,
	IntegrationContext,
	PermissionMode,
	PermissionPolicy,
} from "./types.js";

export interface IntegrationExecutorOptions {
	registry: IntegrationRegistry;
	credentials: CredentialStore;
	approvals: ApprovalStore;
	/**
	 * Approval timeout — pending approvals expire after this duration.
	 * Accepts the same duration syntax as Corsair (`30m`, `1h`, `2h30m`).
	 * Default: 10 minutes.
	 */
	approvalTimeout?: string;
	/**
	 * Returns the permission mode for a given (tenant, plugin) pair.
	 * If omitted, the plugin's declared `permissions.mode` is used (default `cautious`).
	 */
	getMode?: (
		tenantId: string,
		pluginSlug: string,
	) => Promise<PermissionMode | undefined> | PermissionMode | undefined;
	/**
	 * Returns per-endpoint policy overrides for a given (tenant, plugin) pair.
	 * Merged on top of the plugin's declared overrides.
	 */
	getOverrides?: (
		tenantId: string,
		pluginSlug: string,
	) => Promise<Record<string, PermissionPolicy> | undefined>;
}

export interface CallOptions {
	tenantId: string;
	pluginSlug: string;
	endpoint: string;
	args?: unknown;
	signal?: AbortSignal;
}

/**
 * Runtime executor that translates a logical "call this integration endpoint"
 * request into one of three outcomes:
 *   1. Allow — credentials resolved, handler invoked, result returned.
 *   2. Deny  — short-circuit; never touches the upstream API.
 *   3. Pending approval — stores a record in `ApprovalStore` and returns a handle.
 */
export class IntegrationExecutor {
	private readonly registry: IntegrationRegistry;
	private readonly credentials: CredentialStore;
	private readonly approvals: ApprovalStore;
	private readonly approvalTtlMs: number;
	private readonly getMode?: IntegrationExecutorOptions["getMode"];
	private readonly getOverrides?: IntegrationExecutorOptions["getOverrides"];

	constructor(options: IntegrationExecutorOptions) {
		this.registry = options.registry;
		this.credentials = options.credentials;
		this.approvals = options.approvals;
		this.approvalTtlMs = parseDurationMs(options.approvalTimeout ?? "10m");
		this.getMode = options.getMode;
		this.getOverrides = options.getOverrides;
	}

	async call<T = unknown>(options: CallOptions): Promise<ExecuteResult<T>> {
		const plugin = this.registry.require(options.pluginSlug);
		const endpointDef = plugin.endpoints[options.endpoint];
		if (!endpointDef) {
			throw new Error(
				`Endpoint "${options.endpoint}" is not defined on plugin "${options.pluginSlug}"`,
			);
		}

		const mode = await this.resolveMode(
			plugin.slug,
			options.tenantId,
			plugin,
		);
		const override = await this.resolveOverride(
			plugin.slug,
			options.tenantId,
			options.endpoint,
			plugin,
		);
		const policy = evaluatePermission(
			endpointDef.meta.riskLevel,
			mode,
			override,
		);

		if (policy === "deny") {
			return {
				status: "denied",
				reason: `Permission denied: endpoint "${options.endpoint}" is ${endpointDef.meta.riskLevel} but the active mode "${mode}" forbids it.`,
			};
		}

		if (policy === "require_approval") {
			const now = new Date();
			const expiresAt = new Date(now.getTime() + this.approvalTtlMs);
			const approval = await this.approvals.create({
				tenantId: options.tenantId,
				pluginSlug: options.pluginSlug,
				endpoint: options.endpoint,
				args: options.args,
				riskLevel: endpointDef.meta.riskLevel,
				policy: "require_approval",
				expiresAt: expiresAt.toISOString(),
			});
			return {
				status: "pending_approval",
				approvalId: approval.id,
				expiresAt: approval.expiresAt,
				riskLevel: endpointDef.meta.riskLevel,
			};
		}

		// policy === "allow" → resolve credentials and run.
		const creds =
			(await this.credentials.get(
				options.tenantId,
				options.pluginSlug,
			)) ?? {};
		const ctx: IntegrationContext = {
			pluginSlug: options.pluginSlug,
			endpoint: options.endpoint,
			tenantId: options.tenantId,
			credentials: creds,
			signal: options.signal,
		};
		const data = (await endpointDef.handler(ctx, options.args)) as T;
		return { status: "ok", data };
	}

	/**
	 * Run a previously approved pending approval. Idempotent: subsequent calls on
	 * a non-pending record return its current state without re-running the
	 * handler.
	 */
	async runApproved<T = unknown>(
		approvalId: string,
	): Promise<ExecuteResult<T>> {
		const approval = await this.approvals.get(approvalId);
		if (!approval) {
			return {
				status: "denied",
				reason: `Approval ${approvalId} not found`,
			};
		}
		if (approval.status === "denied") {
			return { status: "denied", reason: "Approval was denied" };
		}
		if (approval.status === "expired") {
			return { status: "denied", reason: "Approval expired" };
		}
		if (approval.status !== "approved") {
			return {
				status: "pending_approval",
				approvalId: approval.id,
				expiresAt: approval.expiresAt,
				riskLevel: approval.riskLevel,
			};
		}
		const plugin = this.registry.require(approval.pluginSlug);
		const endpointDef = plugin.endpoints[approval.endpoint];
		if (!endpointDef) {
			throw new Error(
				`Approval ${approvalId} references missing endpoint "${approval.endpoint}" on plugin "${approval.pluginSlug}"`,
			);
		}
		const creds =
			(await this.credentials.get(
				approval.tenantId,
				approval.pluginSlug,
			)) ?? {};
		const ctx: IntegrationContext = {
			pluginSlug: approval.pluginSlug,
			endpoint: approval.endpoint,
			tenantId: approval.tenantId,
			credentials: creds,
		};
		const data = (await endpointDef.handler(ctx, approval.args)) as T;
		return { status: "ok", data };
	}

	private async resolveMode(
		pluginSlug: string,
		tenantId: string,
		plugin: { permissions?: { mode: PermissionMode } },
	): Promise<PermissionMode> {
		const fromTenant = this.getMode
			? await this.getMode(tenantId, pluginSlug)
			: undefined;
		if (fromTenant) {
			return fromTenant;
		}
		return plugin.permissions?.mode ?? "cautious";
	}

	private async resolveOverride(
		pluginSlug: string,
		tenantId: string,
		endpoint: string,
		plugin: {
			permissions?: { overrides?: Record<string, PermissionPolicy> };
		},
	): Promise<PermissionPolicy | undefined> {
		const tenantOverrides = this.getOverrides
			? await this.getOverrides(tenantId, pluginSlug)
			: undefined;
		// Tenant overrides win over plugin-declared overrides.
		return (
			tenantOverrides?.[endpoint] ??
			plugin.permissions?.overrides?.[endpoint]
		);
	}
}
