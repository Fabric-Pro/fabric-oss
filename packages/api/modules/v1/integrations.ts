/**
 * v1 Integrations routes
 *
 *   GET  /integrations                          List integrations connected for caller's tenant
 *   POST /integrations/:slug/:operation         Execute an integration call (permission-gated)
 *   GET  /integrations/approvals                List pending integration approvals
 *   POST /integrations/approvals/:id/approve    Approve a pending request → execute and return result
 *   POST /integrations/approvals/:id/deny       Deny a pending request
 *
 * Wires `@fabricorg/integrations-runtime` to the portal:
 *   - PortalCredentialStore reads from `WorkflowIntegration` (encrypted credentials JSON)
 *   - PortalApprovalStore is Prisma-backed (`IntegrationApproval`)
 *   - All 5 phase-3 plugins are registered in a lazy singleton at first use.
 */

import { githubPlugin } from "@fabricorg/integrations-github";
import { gmailPlugin } from "@fabricorg/integrations-gmail";
import { linearPlugin } from "@fabricorg/integrations-linear";
import { notionPlugin } from "@fabricorg/integrations-notion";
import {
	type ApprovalStore,
	type CredentialStore,
	IntegrationExecutor,
	IntegrationRegistry,
	type PendingApproval,
} from "@fabricorg/integrations-runtime";
import { slackPlugin } from "@fabricorg/integrations-slack";
import { db } from "@repo/database";
import { decryptApiKey } from "@repo/utils";
import type { Hono } from "hono";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import { badRequest, notFound, ok, resolveV1Context } from "./helpers";

// ---------------------------------------------------------------------------
// Slug ↔ WorkflowIntegrationProvider mapping
// ---------------------------------------------------------------------------
// The runtime uses lowercase slugs ("slack"); the portal's enum is uppercase
// ("SLACK"). This map is the single source of truth for the bridge.
const SLUG_TO_PROVIDER: Record<string, string> = {
	slack: "SLACK",
	github: "GITHUB",
	gmail: "GMAIL",
	linear: "LINEAR",
	notion: "NOTION",
};

// ---------------------------------------------------------------------------
// CredentialStore — backed by WorkflowIntegration
// ---------------------------------------------------------------------------
class PortalCredentialStore implements CredentialStore {
	async get(
		tenantId: string,
		pluginSlug: string,
	): Promise<Record<string, unknown> | undefined> {
		const provider = SLUG_TO_PROVIDER[pluginSlug];
		if (!provider) {
			return undefined;
		}
		// tenantId convention here: "user:<id>" or "org:<id>"
		const [scope, id] = tenantId.split(":", 2);
		if (!id) {
			return undefined;
		}
		const where =
			scope === "org"
				? { organizationId: id, isActive: true }
				: { userId: id, organizationId: null, isActive: true };

		// `provider` is the uppercase enum value (e.g. "SLACK") matching
		// WorkflowIntegrationProvider. Cast through `unknown` to avoid pulling
		// the generated enum type into this file.
		type ProviderEnum = NonNullable<
			Parameters<typeof db.workflowIntegration.findFirst>[0]
		>["where"] extends infer W
			? W extends { provider?: infer P }
				? P
				: never
			: never;
		const integration = await db.workflowIntegration.findFirst({
			where: { ...where, provider: provider as unknown as ProviderEnum },
			orderBy: { lastUsedAt: "desc" },
		});
		if (!integration) {
			return undefined;
		}
		try {
			return JSON.parse(decryptApiKey(integration.credentials)) as Record<
				string,
				unknown
			>;
		} catch {
			return undefined;
		}
	}
}

// ---------------------------------------------------------------------------
// ApprovalStore — backed by Prisma IntegrationApproval
// ---------------------------------------------------------------------------
function rowToApproval(row: {
	id: string;
	userId: string;
	organizationId: string | null;
	pluginSlug: string;
	endpoint: string;
	args: unknown;
	riskLevel: string;
	status: string;
	createdAt: Date;
	expiresAt: Date;
}): PendingApproval {
	return {
		id: row.id,
		tenantId: row.organizationId
			? `org:${row.organizationId}`
			: `user:${row.userId}`,
		pluginSlug: row.pluginSlug,
		endpoint: row.endpoint,
		args: row.args,
		riskLevel: row.riskLevel as PendingApproval["riskLevel"],
		policy: "require_approval",
		createdAt: row.createdAt.toISOString(),
		expiresAt: row.expiresAt.toISOString(),
		status: row.status as PendingApproval["status"],
	};
}

class PortalApprovalStore implements ApprovalStore {
	async create(
		input: Omit<PendingApproval, "id" | "createdAt" | "status"> & {
			id?: string;
			createdAt?: string;
		},
	): Promise<PendingApproval> {
		const [scope, id] = input.tenantId.split(":", 2);
		if (!id || (scope !== "user" && scope !== "org")) {
			throw new Error(`Invalid tenantId: "${input.tenantId}"`);
		}
		const row = await db.integrationApproval.create({
			data: {
				userId: scope === "user" ? id : "system",
				organizationId: scope === "org" ? id : null,
				pluginSlug: input.pluginSlug,
				endpoint: input.endpoint,
				args: input.args as object,
				riskLevel: input.riskLevel,
				expiresAt: new Date(input.expiresAt),
			},
		});
		return rowToApproval(row);
	}

	async get(id: string): Promise<PendingApproval | undefined> {
		const row = await db.integrationApproval.findUnique({ where: { id } });
		if (!row) {
			return undefined;
		}
		// Lazy-expire on read
		if (row.status === "pending" && row.expiresAt.getTime() < Date.now()) {
			const expired = await db.integrationApproval.update({
				where: { id },
				data: { status: "expired" },
			});
			return rowToApproval(expired);
		}
		return rowToApproval(row);
	}

	async resolve(
		id: string,
		decision: "approved" | "denied",
	): Promise<PendingApproval | undefined> {
		const existing = await db.integrationApproval.findUnique({
			where: { id },
		});
		if (!existing || existing.status !== "pending") {
			return existing ? rowToApproval(existing) : undefined;
		}
		const row = await db.integrationApproval.update({
			where: { id },
			data: { status: decision, decidedAt: new Date() },
		});
		return rowToApproval(row);
	}
}

// ---------------------------------------------------------------------------
// Lazy singleton: registry + executor
// ---------------------------------------------------------------------------
let cached: {
	registry: IntegrationRegistry;
	executor: IntegrationExecutor;
} | null = null;

function getRuntime() {
	if (cached) {
		return cached;
	}
	const registry = new IntegrationRegistry();
	registry.registerAll([
		slackPlugin,
		githubPlugin,
		gmailPlugin,
		linearPlugin,
		notionPlugin,
	]);
	const executor = new IntegrationExecutor({
		registry,
		credentials: new PortalCredentialStore(),
		approvals: new PortalApprovalStore(),
		approvalTimeout: "30m",
	});
	cached = { registry, executor };
	return cached;
}

function tenantId(ctx: {
	userId: string;
	organizationId: string | null;
}): string {
	return ctx.organizationId
		? `org:${ctx.organizationId}`
		: `user:${ctx.userId}`;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export function registerIntegrationRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	// GET /integrations — list integrations connected for the tenant
	app.get("/integrations", requireScope("integrations:read"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		const where = ctx.organizationId
			? { organizationId: ctx.organizationId, isActive: true }
			: { userId: ctx.userId, organizationId: null, isActive: true };

		const rows = await db.workflowIntegration.findMany({
			where,
			select: { provider: true, name: true, lastUsedAt: true },
			orderBy: { lastUsedAt: "desc" },
		});

		const PROVIDER_TO_SLUG: Record<string, string> = Object.fromEntries(
			Object.entries(SLUG_TO_PROVIDER).map(([slug, p]) => [p, slug]),
		);
		const seen = new Set<string>();
		const integrations = [];
		for (const row of rows) {
			const slug = PROVIDER_TO_SLUG[row.provider];
			if (!slug || seen.has(slug)) {
				continue;
			}
			seen.add(slug);
			const plugin = getRuntime().registry.get(slug);
			integrations.push({
				slug,
				name: plugin?.name ?? row.name,
				status: "connected" as const,
				mode: plugin?.permissions?.mode ?? "cautious",
				source: "plugin" as const,
			});
		}

		return c.json(ok(integrations));
	});

	// POST /integrations/:slug/:operation — execute via runtime
	app.post(
		"/integrations/:slug/:operation",
		requireScope("integrations:execute"),
		async (c) => {
			const apiCtx = c.get("externalApiContext");
			const ctx = await resolveV1Context(
				apiCtx,
				c.req.query("org"),
				c.req.query("personal") === "1",
			);
			if ("error" in ctx) {
				return c.json({ error: { message: ctx.error } }, ctx.status);
			}

			const slug = c.req.param("slug");
			const operation = c.req.param("operation");
			if (!slug || !operation) {
				return c.json(
					badRequest("slug and operation are required"),
					400,
				);
			}
			if (!getRuntime().registry.has(slug)) {
				return c.json(notFound(`Plugin "${slug}"`), 404);
			}

			let body: unknown = {};
			try {
				body = await c.req.json();
			} catch {
				// empty body is OK
			}

			try {
				const result = await getRuntime().executor.call({
					tenantId: tenantId(ctx),
					pluginSlug: slug,
					endpoint: operation,
					args: body,
				});
				return c.json(ok(result));
			} catch (err) {
				const message =
					err instanceof Error ? err.message : String(err);
				return c.json({ error: { message } }, 400);
			}
		},
	);

	// GET /integrations/approvals — list pending approvals
	app.get(
		"/integrations/approvals",
		requireScope("integrations:read"),
		async (c) => {
			const apiCtx = c.get("externalApiContext");
			const ctx = await resolveV1Context(
				apiCtx,
				c.req.query("org"),
				c.req.query("personal") === "1",
			);
			if ("error" in ctx) {
				return c.json({ error: { message: ctx.error } }, ctx.status);
			}

			const where = ctx.organizationId
				? { organizationId: ctx.organizationId }
				: { userId: ctx.userId, organizationId: null };
			const status = c.req.query("status") ?? "pending";

			const rows = await db.integrationApproval.findMany({
				where: { ...where, status },
				orderBy: { createdAt: "desc" },
				take: Math.min(Number(c.req.query("limit") ?? 50), 100),
			});
			return c.json(ok(rows.map(rowToApproval)));
		},
	);

	// POST /integrations/approvals/:id/approve — execute approved record
	app.post(
		"/integrations/approvals/:id/approve",
		requireScope("integrations:execute"),
		async (c) => {
			const id = c.req.param("id");
			if (!id) {
				return c.json(badRequest("id is required"), 400);
			}

			// Tenant-ownership guard (SOC 2 CC6.1/CC6.3). Resolve the caller's
			// tenant and confirm the approval belongs to it BEFORE resolving or
			// executing it. Without this, any API key carrying
			// `integrations:execute` could approve+run ANOTHER tenant's pending
			// action — executing it with that tenant's stored credentials and
			// returning the result. Mirrors the scoping the GET /approvals list
			// already applies.
			const apiCtx = c.get("externalApiContext");
			const ctx = await resolveV1Context(
				apiCtx,
				c.req.query("org"),
				c.req.query("personal") === "1",
			);
			if ("error" in ctx) {
				return c.json({ error: { message: ctx.error } }, ctx.status);
			}
			const owned = await db.integrationApproval.findFirst({
				where: {
					id,
					...(ctx.organizationId
						? { organizationId: ctx.organizationId }
						: { userId: ctx.userId, organizationId: null }),
				},
				select: { id: true },
			});
			if (!owned) {
				return c.json(notFound("Approval"), 404);
			}

			const store = new PortalApprovalStore();
			const resolved = await store.resolve(id, "approved");
			if (!resolved) {
				return c.json(notFound("Approval"), 404);
			}
			const result = await getRuntime().executor.runApproved(id);
			return c.json(ok(result));
		},
	);

	// POST /integrations/approvals/:id/deny
	app.post(
		"/integrations/approvals/:id/deny",
		requireScope("integrations:execute"),
		async (c) => {
			const id = c.req.param("id");
			if (!id) {
				return c.json(badRequest("id is required"), 400);
			}

			// Tenant-ownership guard (SOC 2 CC6.1/CC6.3) — same rationale as
			// /approve: only deny approvals belonging to the caller's tenant.
			const apiCtx = c.get("externalApiContext");
			const ctx = await resolveV1Context(
				apiCtx,
				c.req.query("org"),
				c.req.query("personal") === "1",
			);
			if ("error" in ctx) {
				return c.json({ error: { message: ctx.error } }, ctx.status);
			}
			const owned = await db.integrationApproval.findFirst({
				where: {
					id,
					...(ctx.organizationId
						? { organizationId: ctx.organizationId }
						: { userId: ctx.userId, organizationId: null }),
				},
				select: { id: true },
			});
			if (!owned) {
				return c.json(notFound("Approval"), 404);
			}

			const store = new PortalApprovalStore();
			const resolved = await store.resolve(id, "denied");
			if (!resolved) {
				return c.json(notFound("Approval"), 404);
			}
			return c.json(ok(resolved));
		},
	);
}
