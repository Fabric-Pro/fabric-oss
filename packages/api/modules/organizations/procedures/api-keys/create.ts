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
 *
 * A read-only role may create one too, and that is the part which needs care:
 * "no more than its creator already has" is enforced by nothing except the
 * scope clamp below. See `READ_ONLY_ORG_API_KEY_SCOPES` (Fizzy #2457).
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
 *
 * Every entry names something the minting role already holds. Keep it that way
 * — that premise is what lets `maxScopesForRole` clamp only the viewer role.
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
	// No `"*"`. It used to sit here, and it was the one entry that broke the
	// premise the role clamp below rests on: every other scope names something
	// the minting role already holds, so a key cannot exceed its owner, while
	// `"*"` named everything regardless of who asked. Any member could mint one
	// by calling this procedure directly — the settings picker never offered it
	// — and the only thing standing between that key and an admin-only surface
	// was the request-time owner gate, which covers three scopes, not all of
	// them.
	//
	// Removing it here stops new wildcard keys being minted, by any role.
	// Wildcard keys ALREADY issued keep working: `hasScope` and `scopeSatisfied`
	// test the stored string at request time and never consult this list. That
	// is deliberate — narrowing them at the consumption end would silently strip
	// every MCP scope from every wildcard key, which is the regression the
	// restored-session fix had to undo.
] as const;

export type OrgApiKeyScope = (typeof ORG_API_KEY_SCOPES)[number];

/**
 * The most an organization VIEWER may put on a key (Fizzy #2457).
 *
 * A viewer may now mint a key at all, which breaks the premise the external
 * API's `OWNER_PERMISSION_GATES` table rests on: that "anything a member
 * already holds cannot be escalated by putting it on a key". A viewer holds far
 * less than a member, so without this clamp a read-only role could request
 * `projects:write` or `*` and walk out with write access it does not have in
 * the browser. That is what this set prevents, and it is why the viewer grant
 * in `VIEWER_ORG_PERMISSIONS` and this list have to be read together.
 *
 * Every scope in `ORG_API_KEY_SCOPES` is accounted for below. "Viewer?" is
 * whether `VIEWER_ORG_PERMISSIONS` (packages/permissions/lib/roles.ts) holds
 * the permission the surface behind that scope actually enforces:
 *
 * | Scope                  | Permission behind it        | Viewer? |
 * |------------------------|-----------------------------|---------|
 * | `mcp:read`             | `MCP_READ`                  | yes     |
 * | `mcp:write`            | `MCP_UPDATE`/`MCP_CONNECT`  | no      |
 * | `ai:models:read`       | `AI_MODEL_RESOLVE` (below)  | no      |
 * | `ai:models:resolve`    | `AI_MODEL_RESOLVE`          | no      |
 * | `projects:read`        | `PROJECT_READ`              | yes     |
 * | `projects:write`       | `PROJECT_UPDATE`            | no      |
 * | `agents:read`          | `AGENT_READ`                | yes     |
 * | `agents:execute`       | `AGENT_EXECUTE`             | no      |
 * | `agents:stream`        | `AGENT_READ`                | yes     |
 * | `orgs:read`            | `ORG_READ`                  | yes     |
 * | `features:read`        | `STORY_READ`                | yes     |
 * | `features:write`       | `STORY_CREATE`/`STORY_UPDATE` | no    |
 * | `workspaces:read`      | `WORKSPACE_READ`            | yes     |
 * | `workflows:read`       | `WORKSPACE_READ`            | yes     |
 * | `workflows:run`        | `WORKSPACE_UPDATE`          | no      |
 * | `frames:read`          | `DIAGRAM_READ`              | yes     |
 * | `frames:write`         | `DIAGRAM_CREATE`/`_UPDATE`  | no      |
 * | `chats:read`           | none — own threads only     | yes     |
 * | `audit_log:read`       | `ORG_AUDIT_LOG_READ`        | no      |
 * | `audit_log:export`     | `ORG_AUDIT_LOG_EXPORT`      | no      |
 * | `system_health:read`   | none — any authenticated    | yes     |
 * | `status_updates:read`  | none — any authenticated     | yes    |
 *
 * Four rows are worth their own sentence, because reading the scope name is
 * not enough to get them right:
 *
 *   - `ai:models:read` sounds like a read and is not one. The only surface that
 *     honours it is `resolveModelForAgent`, which accepts it as an alternative
 *     to `ai:models:resolve` and then performs the resolution — the capability
 *     behind `AI_MODEL_RESOLVE`, which is member-and-up.
 *   - `audit_log:read`/`:export` are genuine reads, but of something a viewer
 *     may not see: `ORG_AUDIT_LOG_READ` is admin-and-up. Read-only is not the
 *     same question as viewer-visible, and this is where the two part company.
 *   - `agents:stream` is read-only on its own (`GET /executions/:id/stream`).
 *     It also appears on the execute route, but only to reject a streaming
 *     request early — that route already demands `agents:execute`.
 *   - `chats:read`, `system_health:read` and `status_updates:read` map to no
 *     permission because their handlers gate on authentication alone and return
 *     either the caller's own rows (chats are filtered by `userId`) or
 *     tenant-scoped/global status. Nothing there sits above the viewer role.
 *
 * This is a CREATION-TIME check against the role the caller holds right now.
 * It is not a live guarantee: like every other scope on a key, these survive
 * their owner's later demotion, and only `OWNER_PERMISSION_GATES` in
 * `external-api/middleware/api-key-auth.ts` re-checks anything at request time.
 * A member who mints `projects:write` and is then demoted to viewer keeps a
 * working write key — a known, pre-existing hole that this clamp neither closes
 * nor widens.
 */
const READ_ONLY_ORG_API_KEY_SCOPES: ReadonlySet<OrgApiKeyScope> = new Set([
	"mcp:read",
	"projects:read",
	"agents:read",
	"agents:stream",
	"orgs:read",
	"features:read",
	"workspaces:read",
	"workflows:read",
	"frames:read",
	"chats:read",
	"system_health:read",
	"status_updates:read",
]);

/**
 * The ceiling on what `role` may request, or `null` for "no ceiling".
 *
 * Only the read-only role is clamped. A member's key is already bounded by the
 * premise quoted above — every scope it can name maps to something the member
 * holds — so clamping member-and-up would refuse requests that are not
 * escalations, and would be a behaviour change for existing callers.
 */
function maxScopesForRole(role: string): ReadonlySet<OrgApiKeyScope> | null {
	return role === "viewer" ? READ_ONLY_ORG_API_KEY_SCOPES : null;
}

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
			"Generate an API key carrying your own access within this organization. Any member may create one; a read-only role may create one with read-only scopes.",
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

		// Clamp the requested scopes to the caller's live organization role.
		//
		// This lives in the handler and not in the input schema on purpose: the
		// schema validates a shape and cannot see who is asking, and the role is
		// only known after the membership lookup above.
		//
		// It refuses rather than quietly dropping the scopes it will not grant.
		// Handing someone a key that silently does less than they asked for
		// moves the failure to the first request that needs the missing scope,
		// where it reads as a broken integration rather than a denied one — so
		// the refusal names every scope it rejected and what may be asked for
		// instead. A viewer who sends no `scopes` at all lands here too, since
		// the schema default (`mcp:read`, `mcp:write`) is not a viewer set;
		// the message is what tells them to ask for the read-only ones.
		const allowedScopes = maxScopesForRole(membership.role);
		if (allowedScopes) {
			const refusedScopes = input.scopes.filter(
				(scope) => !allowedScopes.has(scope),
			);

			if (refusedScopes.length > 0) {
				throw new ORPCError("FORBIDDEN", {
					message: `Your role in this organization is read-only, so these scopes cannot be granted: ${refusedScopes.join(", ")}. Available scopes for your role: ${[...allowedScopes].join(", ")}.`,
				});
			}
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
