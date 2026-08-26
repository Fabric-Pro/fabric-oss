/**
 * Fabric MCP Gateway - Authority Service
 *
 * Shared enforcement module for session-scoped runtime authorization.
 * Implements the core concepts from the Pipes-style authorization model:
 *
 * 1. **Provider normalization**: Maps MCP configs and integrations to
 *    canonical provider keys (e.g., "github", "linear", "custom:my-server")
 *
 * 2. **Access level classification**: Determines if a tool operation is
 *    READ or WRITE based on name patterns and annotations
 *
 * 3. **Authority enforcement**: Pre-execution gate that checks for active
 *    grants before allowing tool calls
 *
 * 4. **Grant lifecycle**: Create, approve, consume, expire authority grants
 */

import type { GatewaySession } from "./types";

// ─── Provider Normalization ─────────────────────────────────────────────────
// This map MUST stay in sync with CANONICAL_PROVIDER_KEYS in
// packages/database/prisma/queries/authority-providers.ts
// It is duplicated here to avoid importing @repo/database at module scope
// (which triggers PrismaClient initialization and breaks unit tests).
const CANONICAL_PROVIDER_KEYS: Record<string, string> = {
	github: "github",
	"github-mcp": "github",
	linear: "linear",
	"linear-mcp": "linear",
	gitlab: "gitlab",
	bitbucket: "bitbucket",
	jira: "jira",
	"atlassian-jira": "jira",
	confluence: "confluence",
	"azure-devops": "azure-devops",
	figma: "figma",
	asana: "asana",
	trello: "trello",
	slack: "slack",
	"slack-mcp": "slack",
	"microsoft-teams": "microsoft-teams",
	"microsoft-graph": "microsoft-graph",
	discord: "discord",
	notion: "notion",
	"notion-mcp": "notion",
	"google-drive": "google-drive",
	"google-docs": "google-docs",
	"google-sheets": "google-sheets",
	"google-calendar": "google-calendar",
	gmail: "gmail",
	hubspot: "hubspot",
	salesforce: "salesforce",
	intercom: "intercom",
	datadog: "datadog",
	sentry: "sentry",
	pagerduty: "pagerduty",
	stripe: "stripe",
	twilio: "twilio",
	sendgrid: "sendgrid",
	excalidraw: "excalidraw",
	"excalidraw-mcp": "excalidraw",
};

/**
 * Resolved authority target — the normalized representation of a provider
 * that can be authorized.
 */
export interface ResolvedAuthorityTarget {
	providerType: "MCP" | "INTEGRATION" | "FABRIC_NATIVE";
	providerKey: string;
	displayName: string;
	refId: string;
	supportsRead: boolean;
	supportsWrite: boolean;
	defaultAccessLevel: "READ" | "WRITE";
}

/**
 * Resolve an MCP config into a normalized authority target.
 */
export function resolveProviderFromMcpConfig(config: {
	id: string;
	displayName?: string | null;
	mcpServer?: { key?: string; name?: string } | null;
}): ResolvedAuthorityTarget {
	const serverKey = config.mcpServer?.key?.toLowerCase() ?? "";
	const providerKey = serverKey
		? (CANONICAL_PROVIDER_KEYS[serverKey] ?? `custom:${serverKey}`)
		: `custom:${config.id}`;

	return {
		providerType: "MCP",
		providerKey,
		displayName:
			config.displayName || config.mcpServer?.name || providerKey,
		refId: config.id,
		supportsRead: true,
		supportsWrite: true,
		defaultAccessLevel: "WRITE",
	};
}

/**
 * Resolve a tool prefix (from namespaced tool name) to a provider key.
 * Uses the connected server info from tool aggregation.
 */
export function resolveProviderKeyFromToolPrefix(
	prefix: string,
	servers: Array<{
		configId: string;
		displayName: string;
		toolPrefix: string;
	}>,
): { providerKey: string; refId: string; displayName: string } | null {
	const server = servers.find((s) => s.toolPrefix === prefix);
	if (!server) {
		return null;
	}

	// Try to match the display name to a known provider
	const normalizedName = server.displayName
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");
	for (const [key, canonical] of Object.entries(CANONICAL_PROVIDER_KEYS)) {
		if (normalizedName.includes(key.replace(/-/g, ""))) {
			return {
				providerKey: canonical,
				refId: server.configId,
				displayName: server.displayName,
			};
		}
	}

	return {
		providerKey: `custom:${server.toolPrefix}`,
		refId: server.configId,
		displayName: server.displayName,
	};
}

/**
 * Resolve a platform tool to "fabric" provider key.
 * Platform tools are always authorized (they use Fabric's own data).
 */
export function resolveProviderKeyForPlatformTool(): string {
	return "fabric";
}

// ─── Access Level Classification ────────────────────────────────────────────

/** Patterns that indicate read-only operations */
const READ_PATTERNS = [
	/^list[_-]/i,
	/^get[_-]/i,
	/^search[_-]/i,
	/^read[_-]/i,
	/^find[_-]/i,
	/^fetch[_-]/i,
	/^query[_-]/i,
	/^describe[_-]/i,
	/^show[_-]/i,
	/^count[_-]/i,
	/^check[_-]/i,
	/^view[_-]/i,
	/^browse[_-]/i,
	/^lookup[_-]/i,
];

/** Patterns that indicate write operations */
const WRITE_PATTERNS = [
	/^create[_-]/i,
	/^update[_-]/i,
	/^delete[_-]/i,
	/^remove[_-]/i,
	/^send[_-]/i,
	/^post[_-]/i,
	/^put[_-]/i,
	/^patch[_-]/i,
	/^set[_-]/i,
	/^add[_-]/i,
	/^edit[_-]/i,
	/^modify[_-]/i,
	/^move[_-]/i,
	/^copy[_-]/i,
	/^assign[_-]/i,
	/^unassign[_-]/i,
	/^close[_-]/i,
	/^open[_-]/i,
	/^archive[_-]/i,
	/^restore[_-]/i,
	/^approve[_-]/i,
	/^reject[_-]/i,
	/^transition[_-]/i,
	/^merge[_-]/i,
	/^publish[_-]/i,
	/^execute[_-]/i,
	/^run[_-]/i,
	/^trigger[_-]/i,
	/^invite[_-]/i,
	/^revoke[_-]/i,
	/^upload[_-]/i,
	/^import[_-]/i,
	/^export[_-]/i,
];

/**
 * Classify a tool operation as READ or WRITE.
 * Uses layered heuristics:
 * 1. Explicit annotation (readOnlyHint)
 * 2. Tool name pattern matching
 * 3. Conservative fallback (WRITE)
 */
export function classifyAccessLevel(
	toolName: string,
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean },
): "READ" | "WRITE" {
	// 1. Explicit annotation takes priority
	if (annotations?.readOnlyHint === true) {
		return "READ";
	}
	if (annotations?.destructiveHint === true) {
		return "WRITE";
	}

	// 2. Strip namespace prefix for pattern matching
	const baseName = toolName.includes("__")
		? toolName.split("__").slice(1).join("__")
		: toolName.replace(/^fabric_/, "");

	// 3. Check read patterns
	for (const pattern of READ_PATTERNS) {
		if (pattern.test(baseName)) {
			return "READ";
		}
	}

	// 4. Check write patterns
	for (const pattern of WRITE_PATTERNS) {
		if (pattern.test(baseName)) {
			return "WRITE";
		}
	}

	// 5. Conservative fallback: treat unknown tools as WRITE
	return "WRITE";
}

// ─── Authority Enforcement ──────────────────────────────────────────────────

export interface AuthorityEnforcementResult {
	authorized: boolean;
	grant?: {
		id: string;
		kind: string;
		accessLevel: string;
		expiresAt: Date;
		providerKey: string;
		sessionId: string;
	};
	reason?: string;
	/** If not authorized, what the client should do */
	action?: "request_authority" | "upgrade_access_level" | "approve_pending";
	/** If there's a pending session that needs approval */
	pendingSessionId?: string;
}

/**
 * Check whether a tool call is authorized.
 * This is the pre-execution gate called before every connected server tool call.
 *
 * Platform tools (fabric_*) bypass authority checks — they operate on Fabric's
 * own data and are governed by the existing tenant isolation model.
 *
 * @returns AuthorityEnforcementResult with authorized flag and details
 */
export async function enforceAuthority(params: {
	toolName: string;
	providerKey: string;
	session: GatewaySession;
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
	requestFingerprint?: string;
	/** Bind check to a specific AuthoritySession ID */
	boundAuthoritySessionId?: string;
	/** Bind check to a specific run type */
	boundRunType?:
		| "ORCHESTRATOR"
		| "WORKFLOW"
		| "MCP_GATEWAY"
		| "AGENT_INSTANCE";
	/** Bind check to a specific run ID (e.g., gateway session ID, execution ID) */
	boundRunId?: string;
}): Promise<AuthorityEnforcementResult> {
	const {
		toolName,
		providerKey,
		session,
		annotations,
		requestFingerprint,
		boundAuthoritySessionId,
		boundRunType,
		boundRunId,
	} = params;

	// Platform tools skip authority checks
	if (providerKey === "fabric") {
		return { authorized: true };
	}

	const accessLevel = classifyAccessLevel(toolName, annotations);
	if (accessLevel === "READ") {
		return { authorized: true };
	}

	const { checkAuthority, ensureSensitiveOperationAuthority } = await import(
		"@repo/database"
	);

	const baseToolName = toolName.includes("__")
		? toolName.split("__").slice(1).join("__")
		: toolName;

	const result = boundAuthoritySessionId
		? await checkAuthority({
				userId: session.userId,
				organizationId: session.organizationId || undefined,
				providerKey,
				accessLevel,
				toolName: baseToolName,
				requestFingerprint,
				boundSessionId: boundAuthoritySessionId,
				boundRunType,
				boundRunId,
			})
		: await ensureSensitiveOperationAuthority({
				userId: session.userId,
				organizationId: session.organizationId || undefined,
				providerKey,
				accessLevel,
				providerType: "MCP",
				providerDisplayName: providerKey,
				runType: boundRunType,
				runId: boundRunId,
				toolName: baseToolName,
			});
	const pendingSessionId =
		"pendingSessionId" in result &&
		typeof result.pendingSessionId === "string"
			? result.pendingSessionId
			: undefined;
	const action =
		"action" in result &&
		(result.action === "request_authority" ||
			result.action === "approve_pending" ||
			result.action === "upgrade_access_level")
			? result.action
			: undefined;

	if (result.authorized) {
		return {
			authorized: true,
			grant: result.grant,
		};
	}

	// Check if there's a pending session that could be approved
	const { db } = await import("@repo/database");
	const orgFilter = session.organizationId
		? { organizationId: session.organizationId }
		: { organizationId: null };

	const pendingSession = pendingSessionId
		? { id: pendingSessionId }
		: await db.authoritySession.findFirst({
				where: {
					userId: session.userId,
					...orgFilter,
					status: "PENDING",
					expiresAt: { gt: new Date() },
				},
				select: { id: true },
				orderBy: { requestedAt: "desc" },
			});

	if (pendingSession) {
		return {
			authorized: false,
			reason: result.reason,
			action: "approve_pending",
			pendingSessionId: pendingSession.id,
		};
	}

	const fallbackAction: "request_authority" | "upgrade_access_level" =
		result.reason?.includes("READ authority but WRITE is required")
			? "upgrade_access_level"
			: "request_authority";

	return {
		authorized: false,
		reason: result.reason,
		action: action ?? fallbackAction,
	};
}

// ─── Request Fingerprinting ─────────────────────────────────────────────────

/**
 * Generate a fingerprint for a one-shot request grant.
 * Hashes the tool name and sorted argument keys+values.
 */
export async function generateRequestFingerprint(
	toolName: string,
	args: Record<string, unknown>,
): Promise<string> {
	const sortedArgs = Object.keys(args)
		.sort()
		.map((k) => `${k}=${JSON.stringify(args[k])}`)
		.join("&");
	const payload = `${toolName}:${sortedArgs}`;

	// Use Web Crypto API for hashing
	const encoder = new TextEncoder();
	const data = encoder.encode(payload);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
