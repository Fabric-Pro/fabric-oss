/**
 * Create User API Key Procedure
 *
 * Generates a new API key for the user with specified name and scopes.
 * The raw key is returned only once - it cannot be retrieved later.
 */

import { createHash, randomBytes } from "node:crypto";
import { createUserApiKey } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

// Available scopes for API keys
const API_KEY_SCOPES = [
	// MCP
	"mcp:read", // Read MCP tools/resources
	"mcp:write", // Execute MCP tools
	// Browser automation
	"browser:read", // Read browser automation results
	"browser:write", // Execute browser automation tasks
	// Agents
	"agents:read", // Read agent metadata, list available agents
	"agents:execute", // Trigger agent executions via API
	"agents:stream", // Access real-time execution streams
	// CLI / SDK scopes
	"orgs:read", // List and read organizations
	"projects:read", // Read projects and documents
	"projects:write", // Create and update projects
	"features:read", // Read features/stories
	"features:write", // Create and update features/stories
	"workflows:read", // Read workflows and executions
	"workflows:run", // Trigger workflow executions
	"prompts:read", // Read prompt templates
	"prompts:write", // Create and update prompts
	"frames:read", // Read frames
	"frames:write", // Create and update frames
	"reports:read", // Read report templates and executions
	"reports:write", // Create and run reports
	"skills:read", // Read skill definitions
	"chats:read", // Read AI chat threads
	"chats:write", // Create and send chat messages
	"workspaces:read", // Read workspaces and documents
	"keys:read", // List own API keys
	"keys:write", // Create API keys via v1 API
	"audit_log:read", // Read own audit log via GET /api/v1/audit-log
	"audit_log:export", // Export own audit log via GET /api/v1/audit-log/export
	// Read-only observability. `system_health:read` includes the key owner's own
	// signals (their failure rate, their connection health), so it is not the
	// same grant as `status_updates:read`, which carries only platform
	// announcements and nothing about the workspace.
	"system_health:read", // GET /api/v1/system-health
	"status_updates:read", // GET /api/v1/status-updates
] as const;

/**
 * Generate a secure API key
 * Format: fab_<prefix>_<secret>
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
	const rawKey = `fab_${prefix}_${secret}`;
	const keyPrefix = `fab_${prefix}`;

	// Hash the full key for storage
	const keyHash = createHash("sha256").update(rawKey).digest("hex");

	return { rawKey, keyHash, keyPrefix };
}

export const createUserApiKeyProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_UPDATE_SELF))
	.route({
		method: "POST",
		path: "/users/api-keys",
		tags: ["Users", "API Keys"],
		summary: "Create a new API key",
		description:
			"Generate a new API key for external integrations like MCP Server",
	})
	.input(
		z.object({
			name: z
				.string()
				.min(1, "Name is required")
				.max(100, "Name too long"),
			scopes: z
				.array(z.enum(API_KEY_SCOPES))
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
	.handler(async ({ context: { user }, input }) => {
		// Generate the API key
		const { rawKey, keyHash, keyPrefix } = generateApiKey();

		// Calculate expiration if specified
		const expiresAt = input.expiresInDays
			? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
			: undefined;

		// Create the key in database
		const apiKey = await createUserApiKey({
			userId: user.id,
			name: input.name,
			keyHash,
			keyPrefix,
			scopes: input.scopes,
			expiresAt,
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
