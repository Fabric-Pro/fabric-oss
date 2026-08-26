/**
 * Credential Fetcher for Workflow Integrations
 * Based on Vercel workflow-builder-template patterns
 *
 * Fetches and maps integration credentials from the database.
 * Credentials are decrypted and mapped to environment-style keys.
 */

import { decryptApiKey } from "@repo/utils";
import { db } from "../../client";
import type { WorkflowIntegrationProvider } from "../../generated/enums";

/**
 * Mapped credentials ready for use in step execution
 */
export type WorkflowCredentials = Record<string, string>;

/**
 * Credential mappers for each integration provider
 */
/**
 * Helper to get OAuth token from config - supports both OAuth (access_token) and API key (apiKey)
 */
function getOAuthToken(config: Record<string, unknown>): string {
	return (config.access_token as string) || (config.apiKey as string) || "";
}

const credentialMappers: Partial<
	Record<
		WorkflowIntegrationProvider,
		(config: Record<string, unknown>) => WorkflowCredentials
	>
> = {
	AI_GATEWAY: (config) => ({
		AI_GATEWAY_API_KEY: (config.apiKey as string) || "",
	}),
	FIRECRAWL: (config) => ({
		FIRECRAWL_API_KEY: (config.apiKey as string) || "",
	}),
	LINEAR: (config) => ({
		// Linear supports both OAuth and API key
		LINEAR_API_KEY: getOAuthToken(config),
		LINEAR_TEAM_ID: (config.teamId as string) || "",
	}),
	RESEND: (config) => ({
		RESEND_API_KEY: (config.apiKey as string) || "",
		RESEND_FROM_EMAIL: (config.fromEmail as string) || "",
	}),
	SLACK: (config) => ({
		// Slack uses OAuth - access_token is the primary credential
		SLACK_TOKEN: getOAuthToken(config),
	}),
	DATABASE: (config) => ({
		DATABASE_URL: (config.url as string) || "",
	}),
	DATABRICKS_VECTOR_SEARCH: (config) => ({
		DATABRICKS_HOST: (config.host as string) || "",
		DATABRICKS_CLIENT_ID: (config.clientId as string) || "",
		DATABRICKS_CLIENT_SECRET: (config.clientSecret as string) || "",
	}),
	CUSTOM_WEBHOOK: (config) => ({
		WEBHOOK_URL: (config.url as string) || "",
		WEBHOOK_SECRET: (config.secret as string) || "",
	}),
	MCP: (_config) => ({
		// MCP uses the MCP server configuration, no direct credentials
	}),
	GITHUB: (config) => ({
		// GitHub uses OAuth - access_token is the primary credential
		GITHUB_TOKEN: getOAuthToken(config),
	}),
	PERPLEXITY: (config) => ({
		PERPLEXITY_API_KEY: (config.apiKey as string) || "",
	}),
	FAL: (config) => ({
		FAL_API_KEY: (config.apiKey as string) || "",
	}),
	CONFLUENCE: (config) => ({
		CONFLUENCE_DOMAIN: (config.domain as string) || "",
		CONFLUENCE_EMAIL: (config.email as string) || "",
		CONFLUENCE_API_TOKEN: (config.apiToken as string) || "",
	}),
	GOOGLE_DRIVE: (config) => ({
		// Google Drive uses OAuth - access_token is the primary credential
		GOOGLE_DRIVE_TOKEN: getOAuthToken(config),
		GOOGLE_DRIVE_REFRESH_TOKEN: (config.refresh_token as string) || "",
	}),
	GMAIL: (config) => ({
		GMAIL_ACCESS_TOKEN: getOAuthToken(config),
		GMAIL_REFRESH_TOKEN: (config.refresh_token as string) || "",
	}),
	HUBSPOT: (config) => ({
		HUBSPOT_ACCESS_TOKEN:
			(config.apiToken as string) || getOAuthToken(config),
	}),
	GITLAB: (config) => ({
		GITLAB_URL:
			(config.domain as string) ||
			(config.url as string) ||
			"https://gitlab.com",
		GITLAB_ACCESS_TOKEN:
			(config.apiToken as string) || getOAuthToken(config),
	}),
	MICROSOFT_GRAPH: (config) => ({
		// Microsoft Graph uses OAuth - access_token is the primary credential
		MICROSOFT_ACCESS_TOKEN: getOAuthToken(config),
		MICROSOFT_REFRESH_TOKEN: (config.refresh_token as string) || "",
	}),
	NHTSA_VPIC: (_config) => ({
		// NHTSA VPIC is a public API — no credentials needed
		NHTSA_ENABLED: "true",
	}),
	NOTION: (config) => ({
		// Notion uses OAuth - access_token is the primary credential
		NOTION_TOKEN: getOAuthToken(config),
	}),
	INTERCOM: (config) => ({
		INTERCOM_ACCESS_TOKEN:
			(config.apiToken as string) || getOAuthToken(config),
	}),
	ASANA: (config) => ({
		ASANA_ACCESS_TOKEN: getOAuthToken(config),
	}),
	ATTIO: (config) => ({
		ATTIO_API_KEY: (config.apiKey as string) || "",
	}),
	BITBUCKET: (config) => ({
		BITBUCKET_EMAIL: (config.email as string) || "",
		BITBUCKET_API_TOKEN:
			(config.apiToken as string) || getOAuthToken(config),
		BITBUCKET_WORKSPACE: (config.workspace as string) || "",
	}),
	CANVA: (config) => ({
		CANVA_ACCESS_TOKEN: getOAuthToken(config),
	}),
	CLICKUP: (config) => ({
		CLICKUP_API_TOKEN: getOAuthToken(config),
		CLICKUP_TEAM_ID: (config.teamId as string) || "",
	}),
	FRESHSERVICE: (config) => ({
		FRESHSERVICE_API_KEY: (config.apiKey as string) || "",
		FRESHSERVICE_DOMAIN: (config.domain as string) || "",
	}),
	FRONT: (config) => ({
		FRONT_API_KEY: (config.apiKey as string) || getOAuthToken(config),
	}),
	JIRA: (config) => ({
		JIRA_DOMAIN: (config.domain as string) || "",
		JIRA_EMAIL: (config.email as string) || "",
		JIRA_API_TOKEN: (config.apiToken as string) || getOAuthToken(config),
	}),
	SALESFORCE: (config) => ({
		SALESFORCE_DOMAIN: (config.domain as string) || "",
		SALESFORCE_USERNAME:
			(config.email as string) || (config.username as string) || "",
		SALESFORCE_ACCESS_TOKEN:
			(config.apiToken as string) ||
			(config.apiKey as string) ||
			getOAuthToken(config),
	}),
	ZENDESK: (config) => ({
		ZENDESK_SUBDOMAIN: (config.subdomain as string) || "",
		ZENDESK_EMAIL: (config.email as string) || "",
		ZENDESK_TOKEN: (config.token as string) || getOAuthToken(config),
	}),
};

/**
 * Fetch credentials for an integration by ID
 * Enforces strict isolation between personal and organizational integrations
 */
export async function fetchCredentialsById(
	integrationId: string,
	userId: string,
	organizationId?: string,
): Promise<WorkflowCredentials | null> {
	// Strict isolation: if no organizationId, only allow fetching personal integration credentials
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	const integration = await db.workflowIntegration.findFirst({
		where: {
			id: integrationId,
			userId,
			...orgFilter,
			isActive: true,
		},
	});

	if (!integration) {
		return null;
	}

	return mapIntegrationCredentials(integration);
}

/**
 * Fetch credentials for a specific integration by ID with tenant-level
 * (not owner-level) authorization: in org context any member's runtime may
 * use the org's integration; in personal context the row must belong to
 * the user. Use for runtime paths bound to a stored integrationId.
 */
export async function fetchCredentialsByIdInTenant(
	integrationId: string,
	userId: string,
	organizationId?: string,
): Promise<WorkflowCredentials | null> {
	return fetchActiveIntegrationCredentials(
		{ id: integrationId },
		userId,
		organizationId,
	);
}

/**
 * Shared body of the two exact-ID fetchers: an active row matching `match`,
 * scoped by the tenant XOR (org context is member-wide, personal context is
 * owner-only), mapped to credentials.
 *
 * SECURITY: in org context, "member-wide" means MEMBERS — the caller must
 * actually hold a `Member` row for the organization, not merely arrive with
 * an organizationId in hand. Project-guest authorization
 * (`requireProjectPermission`) promotes the HOST project's organizationId
 * into the request context for an external `ProjectMember` who is NOT an org
 * member, and runtime paths thread that organizationId down here. Filtering
 * `WorkflowIntegration` by organizationId alone would therefore hand the
 * org's real credentials (e.g. its Databricks service principal) to a
 * project-only guest. The membership check makes that caller resolve `null`
 * — the same safe silent no-op as a personal-context caller — while every
 * legitimate org caller (who by definition has a Member row) is unaffected.
 */
async function fetchActiveIntegrationCredentials(
	match: { id: string; provider?: WorkflowIntegrationProvider },
	userId: string,
	organizationId?: string,
): Promise<WorkflowCredentials | null> {
	if (organizationId) {
		const membership = await db.member.findFirst({
			where: { organizationId, userId },
			select: { id: true },
		});
		if (!membership) {
			console.warn(
				`[CredentialFetcher] Org-context credential lookup by non-member denied (user ${userId}, org ${organizationId})`,
			);
			return null;
		}
	}

	const integration = await db.workflowIntegration.findFirst({
		where: {
			...match,
			isActive: true,
			...(organizationId
				? { organizationId }
				: { userId, organizationId: null }),
		},
	});

	if (!integration) {
		return null;
	}

	return mapIntegrationCredentials(integration);
}

/**
 * Fetch credentials for an integration the caller has already identified by ID
 * AND provider, with tenant-level (not owner-level) authorization.
 *
 * Stricter than {@link fetchCredentialsByIdInTenant}: the stored row must also
 * be of the expected provider, so a tampered or stale synthetic tool reference
 * can never resolve to a different integration than the one that was
 * discovered. Used by the LOOM chat integration dispatcher, which must never
 * fall back to provider-wide lookup — that would execute whichever same-provider
 * row happens to sort first, ignoring the user's selection.
 */
export async function fetchCredentialsByIdAndProviderInTenant(
	integrationId: string,
	provider: WorkflowIntegrationProvider,
	userId: string,
	organizationId?: string,
): Promise<WorkflowCredentials | null> {
	return fetchActiveIntegrationCredentials(
		{ id: integrationId, provider },
		userId,
		organizationId,
	);
}

/**
 * Fetch credentials for a provider type with XOR tenant isolation.
 *
 * TENANT ISOLATION (XOR Pattern):
 * - ORGANIZATION CONTEXT: Only org-level integrations
 * - PERSONAL CONTEXT: Only user-level and workflow-level integrations
 *
 * Personal credentials are NEVER accessible in org context and vice versa.
 */
export async function fetchCredentialsByProvider(
	provider: WorkflowIntegrationProvider,
	userId: string,
	organizationId?: string,
): Promise<WorkflowCredentials | null> {
	console.log(
		`[CredentialFetcher] Looking for ${provider} credentials for user ${userId}, org: ${organizationId || "none"}`,
	);

	// XOR PATTERN: Strict context isolation
	if (organizationId) {
		// ORGANIZATION CONTEXT: Only org-level integrations (no user fallback)
		const orgIntegration = await db.workflowIntegration.findFirst({
			where: {
				provider,
				organizationId,
				isActive: true,
			},
			orderBy: { lastUsedAt: "desc" },
		});

		if (orgIntegration) {
			console.log(
				`[CredentialFetcher] Found org-level ${provider} integration: ${orgIntegration.id}`,
			);
			return mapIntegrationCredentials(orgIntegration);
		}

		// NO FALLBACK to user credentials in org context
		console.log(
			`[CredentialFetcher] No org-level ${provider} integration found (XOR: no user fallback in org context)`,
		);
		return null;
	}

	// PERSONAL CONTEXT: Only user-level and workflow-level integrations
	// Try user-level first (no workflowId, organizationId must be null)
	const userIntegration = await db.workflowIntegration.findFirst({
		where: {
			provider,
			userId,
			organizationId: null,
			workflowId: null,
			isActive: true,
		},
		orderBy: { lastUsedAt: "desc" },
	});

	if (userIntegration) {
		console.log(
			`[CredentialFetcher] Found user-level ${provider} integration: ${userIntegration.id}`,
		);
		return mapIntegrationCredentials(userIntegration);
	}

	// Try workflow-level (any workflowId for this user in personal context)
	const workflowIntegration = await db.workflowIntegration.findFirst({
		where: {
			provider,
			userId,
			organizationId: null,
			isActive: true,
		},
		orderBy: { lastUsedAt: "desc" },
	});

	if (workflowIntegration) {
		console.log(
			`[CredentialFetcher] Found workflow-level ${provider} integration: ${workflowIntegration.id}`,
		);
		return mapIntegrationCredentials(workflowIntegration);
	}

	console.log(`[CredentialFetcher] No ${provider} integration found`);
	return null;
}

/**
 * Map integration record to credentials
 */
function mapIntegrationCredentials(integration: {
	provider: WorkflowIntegrationProvider;
	credentials: string;
}): WorkflowCredentials {
	try {
		// Decrypt the stored credentials
		const decryptedJson = decryptApiKey(integration.credentials);
		const config = JSON.parse(decryptedJson) as Record<string, unknown>;

		console.log(
			`[CredentialFetcher] Decrypted ${integration.provider} config keys:`,
			Object.keys(config),
		);

		// Map using the provider-specific mapper
		const mapper = credentialMappers[integration.provider];
		if (!mapper) {
			console.warn(
				`[CredentialFetcher] No mapper for provider: ${integration.provider}`,
			);
			return {};
		}

		const mapped = mapper(config);
		// Log only the credential KEY NAMES for debugging — never any part of the
		// secret VALUES. Even a token prefix is Restricted data and must not reach
		// logs (SOC 2 CC6.1 / data-classification "no exposure in logs"); the
		// previous per-token `substring(0, 10)` logging leaked partial secrets to
		// stdout, bypassing the audit-log redactor.
		console.log(
			`[CredentialFetcher] Mapped ${integration.provider} credential keys:`,
			Object.keys(mapped),
		);

		return mapped;
	} catch (error) {
		console.error("[CredentialFetcher] Error mapping credentials:", error);
		return {};
	}
}

/**
 * Get all configured integrations for a user/org
 * Enforces strict isolation between personal and organizational integrations
 */
export async function getConfiguredIntegrations(
	userId: string,
	organizationId?: string,
): Promise<
	{
		provider: WorkflowIntegrationProvider;
		name: string;
		lastUsedAt: Date | null;
	}[]
> {
	// Strict isolation: if no organizationId, only show personal integrations
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	const integrations = await db.workflowIntegration.findMany({
		where: {
			userId,
			...orgFilter,
			isActive: true,
		},
		select: {
			provider: true,
			name: true,
			lastUsedAt: true,
		},
		orderBy: { createdAt: "desc" },
	});

	return integrations;
}
