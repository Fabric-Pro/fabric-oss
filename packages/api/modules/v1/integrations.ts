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
import type { WorkflowIntegrationProvider } from "@repo/database";
import {
	canUseWorkflowIntegrations,
	db,
	resolveWorkflowIntegrationForProvider,
	workflowIntegrationAccessWhere,
} from "@repo/database";
import { OAUTH_APP_ROW_NAMES } from "@repo/database/prisma/queries/lib/oauth-app-row";
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
interface ExecutionConnection {
	userId: string;
	organizationId: string | null;
	integrationId: string;
}

class PortalCredentialStore implements CredentialStore {
	constructor(private readonly identity: ExecutionConnection) {}
	async get(
		tenantId: string,
		pluginSlug: string,
	): Promise<Record<string, unknown> | undefined> {
		const provider = SLUG_TO_PROVIDER[pluginSlug];
		if (!provider) {
			return undefined;
		}
		if (
			tenantId !== tenantIdFor(this.identity) ||
			!(await canUseWorkflowIntegrations(
				this.identity.userId,
				this.identity.organizationId,
			))
		) {
			throw new Error(
				"The original requester no longer has access to this connection",
			);
		}
		const integration = await db.workflowIntegration.findFirst({
			where: {
				...workflowIntegrationAccessWhere(
					this.identity.userId,
					this.identity.organizationId,
				),
				id: this.identity.integrationId,
				provider: provider as WorkflowIntegrationProvider,
				isActive: true,
			},
		});
		if (!integration) {
			throw new Error("The selected connection is no longer available");
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
	constructor(private readonly identity?: ExecutionConnection) {}
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
		if (!this.identity || input.tenantId !== tenantIdFor(this.identity)) {
			throw new Error("Approval requester and connection are required");
		}
		const row = await db.integrationApproval.create({
			data: {
				userId: this.identity.userId,
				integrationId: this.identity.integrationId,
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
let registry: IntegrationRegistry | null = null;
function getRegistry() {
	if (!registry) {
		registry = new IntegrationRegistry();
		registry.registerAll([
			slackPlugin,
			githubPlugin,
			gmailPlugin,
			linearPlugin,
			notionPlugin,
		]);
	}
	return registry;
}

// Only immutable provider definitions are cached. Actors and connection IDs are
// bound to an individual request, never stored on the process-wide singleton.
function getExecutor(identity: ExecutionConnection) {
	return new IntegrationExecutor({
		registry: getRegistry(),
		credentials: new PortalCredentialStore(identity),
		approvals: new PortalApprovalStore(identity),
		approvalTimeout: "30m",
	});
}

/** Approval visibility and decisions require access for both the caller and original requester. */
async function canAccessApprovalConnection(
	approval: {
		userId: string;
		organizationId: string | null;
		integrationId: string | null;
		pluginSlug: string;
	},
	caller: { userId: string; organizationId: string | null },
): Promise<boolean> {
	const provider = SLUG_TO_PROVIDER[approval.pluginSlug];
	if (
		!approval.integrationId ||
		!provider ||
		approval.userId === "system" ||
		approval.organizationId !== caller.organizationId
	) {
		return false;
	}
	if (
		!(await canUseWorkflowIntegrations(
			caller.userId,
			caller.organizationId,
		))
	) {
		return false;
	}
	if (
		approval.userId !== caller.userId &&
		!(await canUseWorkflowIntegrations(
			approval.userId,
			approval.organizationId,
		))
	) {
		return false;
	}
	return !!(await db.workflowIntegration.findFirst({
		where: {
			id: approval.integrationId,
			provider: provider as WorkflowIntegrationProvider,
			isActive: true,
			AND: [
				workflowIntegrationAccessWhere(
					caller.userId,
					caller.organizationId,
				),
				workflowIntegrationAccessWhere(
					approval.userId,
					approval.organizationId,
				),
			],
		},
		select: { id: true },
	}));
}

function tenantIdFor(ctx: {
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

		if (
			!(await canUseWorkflowIntegrations(ctx.userId, ctx.organizationId))
		) {
			return c.json(
				{ error: { message: "Organization membership is required" } },
				403,
			);
		}
		const where = {
			...workflowIntegrationAccessWhere(ctx.userId, ctx.organizationId),
			isActive: true,
		};

		const rows = await db.workflowIntegration.findMany({
			where: {
				...where,
				// A stored OAuth app (client id and secret) is not a
				// connection: listing it would report an unconnected provider
				// as "connected".
				NOT: { name: { in: OAUTH_APP_ROW_NAMES } },
			},
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
			const plugin = getRegistry().get(slug);
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
			if (!getRegistry().has(slug)) {
				return c.json(notFound(`Plugin "${slug}"`), 404);
			}

			let body: unknown = {};
			try {
				body = await c.req.json();
			} catch {
				// empty body is OK
			}

			try {
				const selected = await resolveWorkflowIntegrationForProvider(
					SLUG_TO_PROVIDER[slug] as WorkflowIntegrationProvider,
					ctx.userId,
					ctx.organizationId,
				);
				if (!selected) {
					return c.json(notFound("Available connection"), 404);
				}
				const result = await getExecutor({
					...ctx,
					integrationId: selected.id,
				}).call({
					tenantId: tenantIdFor(ctx),
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

			const requestedLimit = Number(c.req.query("limit") ?? 50);
			if (!Number.isInteger(requestedLimit) || requestedLimit <= 0) {
				return c.json(
					badRequest("limit must be a positive integer"),
					400,
				);
			}
			const limit = Math.min(requestedLimit, 100);
			const batchSize = 100;
			const visible: Parameters<typeof rowToApproval>[0][] = [];
			let cursorId: string | undefined;
			// Limit visible results, not the tenant-wide candidate set. Unique-ID
			// tie-breaking and an advancing cursor let private rows be skipped
			// without starving older accessible requests or repeating a batch.
			while (visible.length < limit) {
				const rows = await db.integrationApproval.findMany({
					where: { ...where, status },
					orderBy: [{ createdAt: "desc" }, { id: "desc" }],
					take: batchSize,
					...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
				});
				if (rows.length === 0) {
					break;
				}
				for (const row of rows) {
					if (await canAccessApprovalConnection(row, ctx)) {
						visible.push(row);
					}
					if (visible.length === limit) {
						break;
					}
				}
				const lastId = rows[rows.length - 1].id;
				if (lastId === cursorId) {
					throw new Error(
						"Approval pagination cursor did not advance",
					);
				}
				cursorId = lastId;
				if (rows.length < batchSize) {
					break;
				}
			}
			return c.json(ok(visible.map(rowToApproval)));
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
				select: {
					id: true,
					userId: true,
					organizationId: true,
					integrationId: true,
					pluginSlug: true,
				},
			});
			if (!owned) {
				return c.json(notFound("Approval"), 404);
			}

			// Old approvals contain no selected connection (and often a synthetic
			// requester). They cannot safely select a credential after the fact.
			if (!owned.integrationId || owned.userId === "system") {
				return c.json(
					badRequest(
						"Approval has no original connection identity; submit the request again",
					),
					400,
				);
			}
			if (!(await canAccessApprovalConnection(owned, ctx))) {
				return c.json(
					badRequest(
						"No access to the approval's selected connection",
					),
					403,
				);
			}

			const identity: ExecutionConnection = {
				userId: owned.userId,
				organizationId: owned.organizationId,
				integrationId: owned.integrationId,
			};
			try {
				await new PortalCredentialStore(identity).get(
					tenantIdFor(identity),
					owned.pluginSlug,
				);
			} catch {
				return c.json(
					badRequest(
						"The original requester no longer has access to the selected connection",
					),
					403,
				);
			}
			const store = new PortalApprovalStore(identity);
			const resolved = await store.resolve(id, "approved");
			if (!resolved) {
				return c.json(notFound("Approval"), 404);
			}
			try {
				const result = await getExecutor(identity).runApproved(id);
				return c.json(ok(result));
			} catch {
				return c.json(
					badRequest(
						"The selected connection is no longer available",
					),
					403,
				);
			}
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
				select: {
					id: true,
					userId: true,
					organizationId: true,
					integrationId: true,
					pluginSlug: true,
				},
			});
			if (!owned) {
				return c.json(notFound("Approval"), 404);
			}

			if (!(await canAccessApprovalConnection(owned, ctx))) {
				return c.json(
					badRequest(
						"No access to the approval's selected connection",
					),
					403,
				);
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
