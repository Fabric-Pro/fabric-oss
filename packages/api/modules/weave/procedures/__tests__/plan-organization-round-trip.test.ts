/**
 * A weave plan created through the real procedure chain can be read back,
 * listed and started by the same caller (Fizzy #2904 review).
 *
 * `createPlan` stamps a plan with its AUTHORIZED project's organization. The
 * plan- and execution-scoped readers used to filter their lookup on the
 * organization resolved from the input before the project was known — `null`
 * for a project guest, the session's for a member whose active organization is
 * another — so they answered NOT_FOUND for the caller's own new plan. They now
 * load it by id and creator, authorize its project, and only then compare
 * organizations.
 *
 * The plan store below honours a `where` the way Prisma does (an `undefined`
 * field is no filter), so a reader that filters on the wrong organization
 * misses the row here exactly as it would against the database.
 */
import { call } from "@orpc/server";
import {
	ORG_ROLE_PERMISSIONS,
	Permissions,
	PROJECT_ROLE_PERMISSIONS,
} from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_PROJECT = "org-example-project";
const ORG_SESSION = "org-example-session";
const PROJECT_ID = "project-example-1";
const USER_ID = "user-example-1";

type Row = Record<string, unknown> & { id: string; createdAt: Date };

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	resolveEffectiveProjectPermissions: vi.fn(),
	workflowStart: vi.fn(),
	plans: [] as Array<
		Record<string, unknown> & { id: string; createdAt: Date }
	>,
	executions: [] as Array<Record<string, unknown> & { id: string }>,
}));

const { passThrough, matches } = vi.hoisted(() => ({
	passThrough: async () => {
		const { os } = await import("@orpc/server");
		return os.middleware(async ({ next }) => next());
	},
	/** Prisma's scalar equality, with `undefined` meaning "no filter". */
	matches: (row: Record<string, unknown>, where: Record<string, unknown>) =>
		Object.entries(where).every(
			([key, value]) => value === undefined || row[key] === value,
		),
}));

vi.mock("@repo/payments", () => ({}));
vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: (...a: unknown[]) => mocks.getSession(...a) } },
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	logDataEvent: vi.fn(async () => undefined),
}));
vi.mock("@repo/database", () => {
	let sequence = 0;
	return {
		db: {
			project: {
				findUnique: async () => ({
					name: "Example project",
					description: null,
					techStack: null,
					organizationId: ORG_PROJECT,
					repositoryUrl: "https://github.com/example/widgets",
				}),
			},
			weavePlan: {
				create: async ({ data }: { data: Record<string, unknown> }) => {
					sequence += 1;
					const row = {
						...data,
						id: `plan-${sequence}`,
						createdAt: new Date(
							Date.UTC(2026, 0, 1, 0, 0, sequence),
						),
					};
					mocks.plans.push(row);
					return row;
				},
				findFirst: async ({
					where,
				}: {
					where: Record<string, unknown>;
				}) => {
					const row = mocks.plans.find((plan) =>
						matches(plan, where),
					);
					return row ? { ...row, executions: [] } : null;
				},
				findMany: async ({
					where,
					take,
				}: {
					where: Record<string, unknown>;
					take?: number;
				}) =>
					mocks.plans
						.filter((plan) => matches(plan, where))
						.sort(
							(a, b) =>
								b.createdAt.getTime() - a.createdAt.getTime(),
						)
						.slice(0, take)
						.map((plan) => ({ ...plan, executions: [] })),
				count: async ({ where }: { where: Record<string, unknown> }) =>
					mocks.plans.filter((plan) => matches(plan, where)).length,
				update: async () => ({}),
			},
			weaveExecution: {
				create: async ({ data }: { data: Record<string, unknown> }) => {
					const row = { ...data, id: String(data.id) };
					mocks.executions.push(row);
					return row;
				},
				update: async () => ({}),
			},
		},
		getTenantContext: () => ({ effectiveWriteOrgId: null }),
		getOrganizationMembership: vi.fn(),
		grantProjectAccess: vi.fn(),
		hasOrganizationTie: vi.fn(async () => true),
		hasProjectAccess: vi.fn(async () => true),
		StoryVersionConflictError: class extends Error {},
	};
});
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { start: mocks.workflowStart },
	}),
}));
vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (options: unknown) => options,
}));
vi.mock("../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...a: unknown[]) =>
		mocks.resolveEffectiveProjectPermissions(...a),
}));
vi.mock("../../../../lib/rate-limit", () => ({
	checkRateLimit: async () => ({ allowed: true }),
	RATE_LIMIT_PRESETS: {},
}));
vi.mock("../../lib/weave-preflight", () => ({
	assertWeaveServiceHealthy: async () => "http://planner.example.com",
}));
vi.mock("../../lib/run-in-background", () => ({ runInBackground: vi.fn() }));
vi.mock("../../lib/run-pattern-generation", () => ({
	runPatternGeneration: vi.fn(async () => undefined),
}));
// Observability, audit and tenant-store middlewares each reach a database and
// are not under test; the permission middleware and resolvers are real.
vi.mock("../../../../orpc/middleware/request-counter-middleware", async () => ({
	requestCounterMiddleware: await passThrough(),
}));
vi.mock("../../../../orpc/middleware/error-metrics-middleware", async () => ({
	errorMetricsMiddleware: await passThrough(),
}));
vi.mock("../../../../orpc/middleware/audit-error-middleware", async () => ({
	auditErrorMiddleware: await passThrough(),
}));
vi.mock("../../../../orpc/middleware/audit-timing-middleware", async () => ({
	auditTimingMiddleware: await passThrough(),
}));
vi.mock("../../../../orpc/middleware/audit-activity-middleware", async () => ({
	auditActivityMiddleware: await passThrough(),
}));
vi.mock("../../../../orpc/middleware/touch-last-seen", async () => ({
	touchLastSeenMiddleware: await passThrough(),
}));
vi.mock("../../../../orpc/middleware/rpc-rate-limit-middleware", async () => ({
	rpcRateLimitMiddleware: await passThrough(),
}));
vi.mock("../../../../orpc/middleware/tenant-context-middleware", async () => ({
	tenantContextMiddleware: await passThrough(),
	getOrganizationIdFromContext: vi.fn(),
	getTenantFilterFromContext: vi.fn(),
}));

import { createPlanProcedure } from "../create-plan";
import { getPlanProcedure } from "../get-plan";
import { listPlansProcedure } from "../list-plans";
import { startExecutionProcedure } from "../start-execution";

const context = { headers: new Headers() };

/**
 * A caller who reaches the project in ORG_PROJECT, with the permissions a
 * real role grants: a project guest holds a project role (EDITOR — no project
 * role grants AGENT_CREATE), an organization member the organization role.
 */
function caller(
	kind: "project guest" | "organization member",
	activeOrganizationId: string | null,
) {
	mocks.getSession.mockResolvedValue({
		session: { activeOrganizationId },
		user: { id: USER_ID },
	});
	mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
		source: kind === "project guest" ? "project-member" : "org",
		organizationId: ORG_PROJECT,
		permissions: [
			...(kind === "project guest"
				? PROJECT_ROLE_PERMISSIONS.EDITOR
				: ORG_ROLE_PERMISSIONS.member),
		],
		organizationDeleted: false,
	});
}

async function createPlan(organizationId: string | null | undefined) {
	const created = (await call(
		createPlanProcedure,
		{
			projectId: PROJECT_ID,
			name: "Example plan",
			message: "Plan the example",
			...(organizationId === undefined ? {} : { organizationId }),
		},
		{ context },
	)) as { planId: string };
	return created.planId;
}

/** A plan the caller already owns, as an earlier create left it. */
function seedPlan(id: string, organizationId: string | null): Row {
	const row: Row = {
		id,
		projectId: PROJECT_ID,
		userId: USER_ID,
		name: "Existing plan",
		organizationId,
		status: "APPROVED",
		createdAt: new Date(Date.UTC(2025, 6, 1, 0, 0, mocks.plans.length)),
	};
	mocks.plans.push(row);
	return row;
}

const withOrganization = (input: string | null | undefined) =>
	input === undefined ? {} : { organizationId: input };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.plans.length = 0;
	mocks.executions.length = 0;
	mocks.workflowStart.mockResolvedValue({ firstExecutionRunId: "run-1" });
});

describe("an organization member whose active organization is another", () => {
	beforeEach(() => caller("organization member", ORG_SESSION));

	it("creates a plan stamped with the project's organization", async () => {
		await createPlan(undefined);
		expect(mocks.plans[0]?.organizationId).toBe(ORG_PROJECT);
	});

	it("reads it back, lists it and starts it in the project's organization", async () => {
		const planId = await createPlan(undefined);

		await expect(
			call(getPlanProcedure, { planId }, { context }),
		).resolves.toMatchObject({ id: planId, organizationId: ORG_PROJECT });

		const listed = (await call(
			listPlansProcedure,
			{ projectId: PROJECT_ID },
			{ context },
		)) as { plans: Array<{ id: string }>; total: number };
		expect(listed.plans.map((plan) => plan.id)).toEqual([planId]);

		(mocks.plans.find((plan) => plan.id === planId) as Row).status =
			"APPROVED";
		await call(startExecutionProcedure, { planId }, { context });
		expect(mocks.executions[0]?.organizationId).toBe(ORG_PROJECT);
		const options = mocks.workflowStart.mock.calls[0]?.[1] as {
			args: Array<{ organizationId?: string }>;
		};
		expect(options.args[0]?.organizationId).toBe(ORG_PROJECT);
	});
});

describe("a project guest", () => {
	beforeEach(() => caller("project guest", null));

	it("cannot create a plan — no project role grants it", async () => {
		expect(PROJECT_ROLE_PERMISSIONS.EDITOR).not.toContain(
			Permissions.AGENT_CREATE,
		);
		await expect(createPlan(null)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.plans).toEqual([]);
	});
});

describe.each([
	{ label: "sending null", input: null },
	{ label: "sending nothing", input: undefined },
])("a project guest's own existing plans, $label", ({ input }) => {
	beforeEach(() => caller("project guest", null));

	it.each([
		["stamped with the project's organization", ORG_PROJECT],
		["stamped with none (legacy)", null],
	])("reads back a plan %s", async (_label, stored) => {
		seedPlan("plan-guest", stored);
		await expect(
			call(
				getPlanProcedure,
				{ planId: "plan-guest", ...withOrganization(input) },
				{ context },
			),
		).resolves.toMatchObject({ id: "plan-guest" });
	});

	it("lists both, newest first", async () => {
		seedPlan("plan-legacy", null);
		seedPlan("plan-current", ORG_PROJECT);
		const listed = (await call(
			listPlansProcedure,
			{ projectId: PROJECT_ID, ...withOrganization(input) },
			{ context },
		)) as { plans: Array<{ id: string }>; total: number };
		expect(listed.plans.map((plan) => plan.id)).toEqual([
			"plan-current",
			"plan-legacy",
		]);
		expect(listed.total).toBe(2);
	});

	it.each([
		["stamped with the project's organization", ORG_PROJECT],
		["stamped with none (legacy)", null],
	])(
		"starts a plan %s in the project's organization",
		async (_label, stored) => {
			seedPlan("plan-guest", stored);
			await call(
				startExecutionProcedure,
				{ planId: "plan-guest", ...withOrganization(input) },
				{ context },
			);
			expect(mocks.executions[0]?.organizationId).toBe(ORG_PROJECT);
			const options = mocks.workflowStart.mock.calls[0]?.[1] as {
				args: Array<{ organizationId?: string }>;
			};
			expect(options.args[0]?.organizationId).toBe(ORG_PROJECT);
		},
	);
});

describe("plan readers still refuse", () => {
	beforeEach(() => caller("organization member", ORG_PROJECT));

	it("another organization named for the caller's own plan", async () => {
		const planId = await createPlan(null);
		await expect(
			call(
				getPlanProcedure,
				{ planId, organizationId: ORG_SESSION },
				{ context },
			),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "organizationId does not match the project",
		});
	});

	it("another caller's plan", async () => {
		const planId = await createPlan(null);
		mocks.getSession.mockResolvedValue({
			session: { activeOrganizationId: ORG_PROJECT },
			user: { id: "user-example-2" },
		});
		await expect(
			call(getPlanProcedure, { planId }, { context }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("listing a project's legacy plans", () => {
	beforeEach(() => caller("organization member", ORG_PROJECT));

	function legacyPlan(id: string, userId: string, second: number): Row {
		return {
			id,
			projectId: PROJECT_ID,
			userId,
			organizationId: null,
			status: "DRAFT",
			createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, second)),
		};
	}

	it("includes the caller's own plans stamped with no organization, newest first", async () => {
		mocks.plans.push(legacyPlan("legacy-own", USER_ID, 1));
		mocks.plans.push(legacyPlan("legacy-other", "user-example-2", 2));
		const planId = await createPlan(null);

		const listed = (await call(
			listPlansProcedure,
			{ projectId: PROJECT_ID },
			{ context },
		)) as { plans: Array<{ id: string }>; total: number };

		expect(listed.plans.map((plan) => plan.id)).toEqual([
			planId,
			"legacy-own",
		]);
		expect(listed.total).toBe(2);
	});

	it("pages across both sets in one order", async () => {
		mocks.plans.push(legacyPlan("legacy-own", USER_ID, 1));
		const planId = await createPlan(null);

		const page = (await call(
			listPlansProcedure,
			{ projectId: PROJECT_ID, limit: 1, offset: 1 },
			{ context },
		)) as { plans: Array<{ id: string }>; total: number };

		expect(planId).not.toBe("legacy-own");
		expect(page.plans.map((plan) => plan.id)).toEqual(["legacy-own"]);
		expect(page.total).toBe(2);
	});
});

describe("listing bounds", () => {
	beforeEach(() => caller("organization member", ORG_PROJECT));

	// Each of the two merged queries reads `offset + limit` rows, so both are
	// bounded at the input.
	it.each([
		["an offset past the cap", { offset: 100_000, limit: 10 }],
		["a negative offset", { offset: -1 }],
		["a fractional offset", { offset: 1.5 }],
		["a limit past the cap", { limit: 101 }],
		["a zero limit", { limit: 0 }],
	])("refuses %s before any query", async (_label, page) => {
		const findMany = vi.spyOn(
			(await import("@repo/database")).db.weavePlan,
			"findMany",
		);
		await expect(
			call(
				listPlansProcedure,
				{ projectId: PROJECT_ID, ...page },
				{ context },
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(findMany).not.toHaveBeenCalled();
	});

	it("accepts the largest page the web client asks for", async () => {
		await expect(
			call(
				listPlansProcedure,
				{ projectId: PROJECT_ID, limit: 50, offset: 10_000 },
				{ context },
			),
		).resolves.toMatchObject({ total: 0 });
	});
});
