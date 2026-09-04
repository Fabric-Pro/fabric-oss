/**
 * Create Organization API Key Procedure
 *
 * Generates a new API key scoped to its creator's own access within the
 * organization, with the given name and scopes. The raw key is returned only
 * once — it cannot be retrieved later.
 *
 * Any member may create one. The key carries no more than its creator already
 * has, so minting it grants nothing new; it changes which client that access
 * can be reached from, and nothing else.
 */

import { createHash, randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { createOrganizationApiKey } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireOrgMembership } from "../../lib/membership";

/**
 * Scopes an organization key may be granted.
 *
 * Exported so the settings picker and the MCP tool map can be checked against
 * it: a scope the API accepts but the picker never offers is unreachable, and a
 * scope a tool demands but the API rejects is a key that cannot be made. Both
 * had happened.
 */
export const ORG_API_KEY_SCOPES = [
	"mcp:read", // Read MCP tools/resources
	"mcp:write", // Execute MCP tools
	"ai:models:read", // Read available AI models
	"ai:models:resolve", // Resolve AI model configuration
	"projects:read", // Read project data
	"projects:write", // Modify project data
	"agents:read", // Read agent metadata, list available agents
	"agents:execute", // Trigger agent executions via API
	"agents:stream", // Access real-time execution streams
	// The MCP tool surface. Until scopes were enforced there, `mcp:read` and
	// `mcp:write` were the only way to describe any of it, so an organization
	// key could not be narrowed to, say, reading features without also being
	// able to read everything else. These name the areas the platform tools
	// actually divide into; the coarse `mcp:*` pair still covers all of them.
	"orgs:read", // List and read organizations
	"features:read", // Read features, bugs and their decision history
	"features:write", // Create and update features, bugs and their tasks
	"workspaces:read", // Read workspaces and run RAG queries
	"workflows:read", // Read workflows and their executions
	"workflows:run", // Trigger workflow executions
	"frames:read", // Read frames and slideshows
	"frames:write", // Create, update and share frames
	"chats:read", // Read AI chat threads
	"audit_log:read", // Read the org's audit log via GET /api/v1/audit-log
	"audit_log:export", // Export the org's audit log via GET /api/v1/audit-log/export
	"system_health:read", // GET /api/v1/system-health (includes the org's own signals)
	"status_updates:read", // GET /api/v1/status-updates (platform announcements only)
	"*", // Full access
] as const;

/**
 * Generate a secure API key
 * Format: org_<prefix>_<secret>
 */
function generateApiKey(): {
	rawKey: string;
	keyHash: string;
	keyPrefix: string;
} {
	// Generate random bytes for the secret
	const secretBytes = randomBytes(24);
	const secret = secretBytes.toString("base64url");

	// Generate prefix (8 chars)
	const prefixBytes = randomBytes(4);
	const prefix = prefixBytes.toString("hex");

	// Construct the full key
	const rawKey = `org_${prefix}_${secret}`;
	const keyPrefix = `org_${prefix}`;

	// Hash the full key for storage
	const keyHash = createHash("sha256").update(rawKey).digest("hex");

	return { rawKey, keyHash, keyPrefix };
}

export const createOrganizationApiKeyProcedure = tenantProtectedProcedure
	// `ORG_API_KEYS_CREATE`, not `ORG_UPDATE`. The dedicated permission has
	// existed since the matrix was written and was never enforced anywhere;
	// borrowing the generic one instead is what tied "may mint a key" to "may
	// rename the organization" and left members with no path but promotion.
	.use(requirePermission(Permissions.ORG_API_KEYS_CREATE))
	.route({
		method: "POST",
		path: "/organizations/{organizationId}/api-keys",
		tags: ["Organizations", "API Keys"],
		summary: "Create a new organization API key",
		description:
			"Generate an API key carrying your own access within this organization. Any member may create one.",
	})
	.input(
		z.object({
			organizationId: z.string().min(1, "Organization ID is required"),
			name: z
				.string()
				.min(1, "Name is required")
				.max(100, "Name too long"),
			scopes: z
				.array(z.enum(ORG_API_KEY_SCOPES))
				.default(["mcp:read", "mcp:write"]),
			expiresInDays: z.number().int().min(1).max(365).optional(),
		}),
	)
	.output(
		z.object({
			id: z.string(),
			name: z.string(),
			keyPrefix: z.string(),
			rawKey: z.string(), // Only returned once!
			scopes: z.array(z.string()),
			expiresAt: z.date().nullable(),
			createdAt: z.date(),
		}),
	)
	.handler(async ({ context, input }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		// Membership, with no role list. The role question is settled above by
		// the permission middleware; repeating it here as a hardcoded pair was
		// the second of two gates, and relaxing only one of them would have
		// left the procedure refusing members for a reason nobody could find.
		const membership = await requireOrgMembership(
			user.id,
			// biome-ignore lint/style/noNonNullAssertion: organizationId is guaranteed by org-protected procedure
			organizationId!,
		);

		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message: "You must be a member of this organization",
			});
		}

		// Generate the API key
		const { rawKey, keyHash, keyPrefix } = generateApiKey();

		// Calculate expiration if specified
		const expiresAt = input.expiresInDays
			? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
			: undefined;

		// Create the key in database
		const apiKey = await createOrganizationApiKey({
			// biome-ignore lint/style/noNonNullAssertion: organizationId is guaranteed by org-protected procedure
			organizationId: organizationId!,
			createdByUserId: user.id,
			name: input.name,
			keyHash,
			keyPrefix,
			scopes: input.scopes,
			expiresAt,
		});

		// Audit-log emission. Do NOT include the raw key, hash, or
		// prefix in metadata — the redactor would catch `rawKey` but better to
		// omit at source. Metadata is the user-meaningful summary: name, scope
		// list, and TTL.
		recordAuditFromRequest(context, {
			action: "org.api_key.created",
			category: "org",
			organizationId,
			resource: {
				type: "api_key",
				id: apiKey.id,
				name: apiKey.name,
			},
			metadata: {
				scopes: apiKey.scopes,
				expiresAt: apiKey.expiresAt?.toISOString() ?? null,
			},
		});

		return {
			id: apiKey.id,
			name: apiKey.name,
			keyPrefix: apiKey.keyPrefix,
			rawKey, // Return only once - user must copy this
			scopes: apiKey.scopes,
			expiresAt: apiKey.expiresAt,
			createdAt: apiKey.createdAt,
		};
	});
