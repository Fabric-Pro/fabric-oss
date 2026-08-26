/**
 * Public v1 API Routes
 *
 * Curated, versioned, stable HTTP surface for @fabricorg/sdk and @fabricorg/cli.
 * Authenticated via API keys (Bearer fab_* / org_*).
 *
 * Base path: /api/v1
 *
 * Routes:
 *   GET  /auth/whoami        → Identity + org memberships
 *   GET  /auth/keys          → List caller's API keys
 *   POST /auth/keys          → Create an API key
 *   DELETE /auth/keys/:id    → Revoke an API key
 *   GET  /orgs               → List orgs the caller belongs to
 */

import { createHash, randomBytes } from "node:crypto";
import { createUserApiKey, db, listUserApiKeys } from "@repo/database";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
	requireApiKey,
	requireScope,
} from "../external-api/middleware/api-key-auth";
import { externalApiRateLimit } from "../external-api/middleware/api-rate-limit";
import type { ExternalApiVariables } from "../external-api/types";
import { registerAgentRoutes } from "./agents";
import { registerChannelRoutes } from "./channels";
import { registerChatRoutes } from "./chats";
import { registerDocumentRoutes } from "./documents";
import { registerFeatureRoutes } from "./features";
import { registerFrameRoutes } from "./frames";
import { registerIntegrationRoutes } from "./integrations";
import { registerKnowledgeRoutes } from "./knowledge";
import { registerMcpRoutes } from "./mcp";
import { registerProjectRoutes } from "./projects";
import { registerPromptRoutes } from "./prompts";
import { registerReportRoutes } from "./reports";
import { registerSkillRoutes } from "./skills";
import { registerWorkflowRoutes } from "./workflows";
import { registerWorkspaceRoutes } from "./workspaces";

// ---------------------------------------------------------------------------
// CLI-facing scopes available when creating keys via v1 API
// ---------------------------------------------------------------------------
const CLI_SCOPES = [
	"keys:read",
	"keys:write",
	"orgs:read",
	"projects:read",
	"projects:write",
	"features:read",
	"features:write",
	"documents:read",
	"documents:write",
	"workflows:read",
	"workflows:run",
	"prompts:read",
	"prompts:write",
	"frames:read",
	"frames:write",
	"reports:read",
	"reports:write",
	"skills:read",
	"chats:read",
	"chats:write",
	"workspaces:read",
	"agents:read",
	"agents:execute",
	"agents:stream",
	"mcp:read",
	"mcp:write",
	"integrations:read",
	"integrations:execute",
	"channels:read",
	"channels:write",
	"knowledge:read",
	"keys:write",
	"audit_log:read",
	"audit_log:export",
] as const;

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------
function ok<T>(data: T, meta?: Record<string, unknown>) {
	return { data, ...(meta ? { meta } : {}) };
}

function err(message: string) {
	return { error: { message } };
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------
export function createPublicV1Routes() {
	const app = new Hono<{ Variables: ExternalApiVariables }>();

	// Relaxed CORS — API key auth, no cookies
	app.use(
		"*",
		cors({
			origin: "*",
			allowHeaders: ["Content-Type", "Authorization", "X-Correlation-ID"],
			allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
			exposeHeaders: [
				"X-Correlation-ID",
				"X-RateLimit-Limit",
				"X-RateLimit-Remaining",
				"X-RateLimit-Reset",
			],
			maxAge: 3600,
			credentials: false,
		}),
	);

	// API key authentication on all v1 routes
	app.use("*", requireApiKey());

	// Rate limiting per API key
	app.use("*", externalApiRateLimit("agent"));

	// =========================================================================
	// Auth — /auth/*
	// =========================================================================

	/**
	 * GET /auth/whoami
	 * Returns the authenticated identity: user profile + org memberships.
	 */
	app.get("/auth/whoami", async (c) => {
		const ctx = c.get("externalApiContext");

		const user = await db.user.findUnique({
			where: { id: ctx.userId },
			select: {
				id: true,
				name: true,
				email: true,
				role: true,
				createdAt: true,
				members: {
					select: {
						id: true,
						role: true,
						createdAt: true,
						organization: {
							select: {
								id: true,
								name: true,
								slug: true,
								logo: true,
								createdAt: true,
							},
						},
					},
				},
			},
		});

		if (!user) {
			return c.json(err("User not found"), 404);
		}

		const { members, ...userFields } = user;
		const orgs = members.map((m) => ({
			id: m.organization.id,
			name: m.organization.name,
			slug: m.organization.slug,
			logo: m.organization.logo,
			role: m.role,
			joinedAt: m.createdAt,
		}));

		return c.json(
			ok({
				user: userFields,
				keyType: ctx.keyType,
				keyPrefix: ctx.keyPrefix,
				scopes: ctx.scopes,
				...(ctx.organizationId
					? { organizationContext: ctx.organizationId }
					: {}),
				orgs,
			}),
		);
	});

	/**
	 * GET /auth/keys
	 * Lists API keys for the authenticated user (no raw keys).
	 */
	app.get("/auth/keys", requireScope("keys:read"), async (c) => {
		const ctx = c.get("externalApiContext");

		const keys = await listUserApiKeys({ userId: ctx.userId });

		return c.json(ok(keys, { total: keys.length }));
	});

	/**
	 * POST /auth/keys
	 * Creates a new API key. Returns the raw key exactly once.
	 */
	app.post("/auth/keys", requireScope("keys:write"), async (c) => {
		const ctx = c.get("externalApiContext");

		let body: { name?: string; scopes?: string[]; expiresInDays?: number };
		try {
			body = await c.req.json();
		} catch {
			return c.json(err("Invalid JSON body"), 400);
		}

		const name = body.name?.trim();
		if (!name) {
			return c.json(err("name is required"), 400);
		}
		if (name.length > 100) {
			return c.json(err("name must be 100 characters or fewer"), 400);
		}

		const requestedScopes = body.scopes ?? ["orgs:read"];
		const validScopes = CLI_SCOPES as readonly string[];
		const invalidScopes = requestedScopes.filter(
			(s) => !validScopes.includes(s),
		);
		if (invalidScopes.length > 0) {
			return c.json(
				err(`Invalid scopes: ${invalidScopes.join(", ")}`),
				400,
			);
		}

		// Scope escalation check: requested scopes must be a subset of caller's own scopes
		const callerScopes = ctx.scopes;
		const escalatedScopes = requestedScopes.filter(
			(s) => !callerScopes.includes(s),
		);
		if (escalatedScopes.length > 0) {
			return c.json(
				err(
					`Cannot grant scopes you don't have: ${escalatedScopes.join(", ")}`,
				),
				403,
			);
		}

		// Org keys cannot mint personal (fab_) keys
		if (ctx.keyType === "organization") {
			return c.json(
				err("Organization API keys cannot create personal API keys"),
				403,
			);
		}

		if (
			body.expiresInDays !== undefined &&
			(typeof body.expiresInDays !== "number" ||
				body.expiresInDays < 1 ||
				body.expiresInDays > 365)
		) {
			return c.json(err("expiresInDays must be between 1 and 365"), 400);
		}

		// Generate key: fab_<8hex>_<24-byte base64url>
		const secretBytes = randomBytes(24);
		const secret = secretBytes.toString("base64url");
		const prefixBytes = randomBytes(4);
		const prefix = prefixBytes.toString("hex");
		const rawKey = `fab_${prefix}_${secret}`;
		const keyPrefix = `fab_${prefix}`;
		const keyHash = createHash("sha256").update(rawKey).digest("hex");

		const expiresAt = body.expiresInDays
			? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
			: undefined;

		const apiKey = await createUserApiKey({
			userId: ctx.userId,
			name,
			keyHash,
			keyPrefix,
			scopes: requestedScopes,
			expiresAt,
		});

		return c.json(
			ok({
				id: apiKey.id,
				name: apiKey.name,
				keyPrefix: apiKey.keyPrefix,
				rawKey, // Only returned once
				scopes: apiKey.scopes,
				expiresAt: apiKey.expiresAt,
				createdAt: apiKey.createdAt,
			}),
			201,
		);
	});

	/**
	 * DELETE /auth/keys/:id
	 * Revokes (permanently deletes) an API key owned by the caller.
	 */
	app.delete("/auth/keys/:id", async (c) => {
		const ctx = c.get("externalApiContext");
		const id = c.req.param("id");

		const key = await db.userApiKey.findFirst({
			where: { id, userId: ctx.userId },
			select: { id: true },
		});

		if (!key) {
			return c.json(err("API key not found"), 404);
		}

		await db.userApiKey.delete({ where: { id } });

		return c.json(ok({ id, deleted: true }));
	});

	// =========================================================================
	// Orgs — /orgs
	// =========================================================================

	/**
	 * GET /orgs
	 * Lists organizations the authenticated user belongs to.
	 */
	app.get("/orgs", requireScope("orgs:read"), async (c) => {
		const ctx = c.get("externalApiContext");

		const memberships = await db.member.findMany({
			where: { userId: ctx.userId },
			select: {
				id: true,
				role: true,
				createdAt: true,
				organization: {
					select: {
						id: true,
						name: true,
						slug: true,
						logo: true,
						createdAt: true,
					},
				},
			},
			orderBy: { createdAt: "asc" },
		});

		const orgs = memberships.map((m) => ({
			id: m.organization.id,
			name: m.organization.name,
			slug: m.organization.slug,
			logo: m.organization.logo ?? null,
			role: m.role,
			joinedAt: m.createdAt,
		}));

		return c.json(ok(orgs, { total: orgs.length }));
	});

	// =========================================================================
	// Resource sub-modules
	// =========================================================================
	registerProjectRoutes(app);
	registerFeatureRoutes(app);
	registerDocumentRoutes(app);
	registerWorkflowRoutes(app);
	registerPromptRoutes(app);
	registerAgentRoutes(app);
	registerSkillRoutes(app);
	registerMcpRoutes(app);
	registerFrameRoutes(app);
	registerWorkspaceRoutes(app);
	registerChatRoutes(app);
	registerReportRoutes(app);
	registerIntegrationRoutes(app);
	registerChannelRoutes(app);
	registerKnowledgeRoutes(app);

	return app;
}
