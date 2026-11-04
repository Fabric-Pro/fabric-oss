/**
 * Real session authentication, project permission and organization binding chain;
 * observability/tenant DB setup and the canonical source reader are isolated.
 * Reader-specific live-ACL tests live alongside context-reader.ts.
 */

import { inspect } from "node:util";
import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SavedEvaluationError } from "../saved-contracts";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	permissions: vi.fn(),
	inspect: vi.fn(),
	evaluate: vi.fn(),
	grantProjectAccess: vi.fn(),
}));

const { passThrough } = vi.hoisted(() => ({
	passThrough: async () => {
		const { os } = await import("@orpc/server");
		return os.middleware(async ({ next }) => next());
	},
}));

vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: mocks.getSession } },
}));
vi.mock("@repo/payments", () => ({}));
vi.mock("@repo/config", () => ({ config: {} }));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@repo/database", () => ({
	db: {},
	getTenantContext: () => ({ effectiveWriteOrgId: null }),
	getOrganizationMembership: vi.fn(),
	hasOrganizationTie: vi.fn(),
	isPlatformAdmin: vi.fn(),
	grantProjectAccess: mocks.grantProjectAccess,
	StoryVersionConflictError: class extends Error {},
}));
vi.mock("../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: mocks.permissions,
}));
vi.mock("../../../lib/rate-limit", () => ({
	checkRateLimit: async () => ({
		allowed: true,
		remaining: 1,
		resetInSeconds: 60,
	}),
	RATE_LIMIT_PRESETS: {},
}));
vi.mock("../../../orpc/middleware/request-counter-middleware", async () => ({
	requestCounterMiddleware: await passThrough(),
}));
vi.mock("../../../orpc/middleware/error-metrics-middleware", async () => ({
	errorMetricsMiddleware: await passThrough(),
}));
vi.mock("../../../orpc/middleware/audit-error-middleware", async () => ({
	auditErrorMiddleware: await passThrough(),
}));
vi.mock("../../../orpc/middleware/audit-timing-middleware", async () => ({
	auditTimingMiddleware: await passThrough(),
}));
vi.mock("../../../orpc/middleware/audit-activity-middleware", async () => ({
	auditActivityMiddleware: await passThrough(),
}));
vi.mock("../../../orpc/middleware/touch-last-seen", async () => ({
	touchLastSeenMiddleware: await passThrough(),
}));
vi.mock("../../../orpc/middleware/rpc-rate-limit-middleware", async () => ({
	rpcRateLimitMiddleware: await passThrough(),
}));
vi.mock("../../../orpc/middleware/tenant-context-middleware", async () => ({
	tenantContextMiddleware: await passThrough(),
	getOrganizationIdFromContext: vi.fn(),
	getTenantFilterFromContext: vi.fn(),
}));
vi.mock("../lib/agent-result", () => ({
	agentResultCommands: async () => ({
		inspect: mocks.inspect,
		evaluate: mocks.evaluate,
	}),
}));

import { agentResultQualityRouter } from "../agent-result-router";

const ORG = "example-org";
const PROJECT = "example-project";
const USER = "example-user";
const EXECUTION = "example-execution";
const request = { projectId: PROJECT, executionId: EXECUTION };
const expectations = {
	expectedRevision: "a".repeat(64),
	requiredPhrases: ["Example answer"],
	forbiddenPhrases: [],
};
const actor = { projectId: PROJECT, organizationId: ORG, userId: USER };
const context = () => ({ headers: new Headers(), resHeaders: new Headers() });
beforeEach(() => {
	vi.resetAllMocks();
	mocks.getSession.mockResolvedValue({
		user: { id: USER },
		session: { activeOrganizationId: ORG },
	});
	mocks.permissions.mockResolvedValue({
		source: "org",
		organizationId: ORG,
		permissions: ["context:read"],
	});
	mocks.inspect.mockResolvedValue({
		recordedAnswer: "Example answer",
		revision: "a".repeat(64),
	});
	mocks.evaluate.mockResolvedValue({
		status: "passed",
		origin: { executionId: EXECUTION, saved: false },
	});
});
describe("agent-result oRPC authentication and input privacy", () => {
	it("authenticates inspection and consumes only its permission-bound project organization", async () => {
		const ctx = context();
		const result = await call(agentResultQualityRouter.inspect, request, {
			context: ctx,
		});
		expect(result).toMatchObject({ recordedAnswer: "Example answer" });
		expect(mocks.inspect).toHaveBeenCalledExactlyOnceWith(actor, {
			executionId: EXECUTION,
		});
		expect(ctx.resHeaders.get("cache-control")).toBe("private, no-store");
	});
	it("validates and normalizes run expectations before invoking the shared command", async () => {
		const ctx = context();
		await call(
			agentResultQualityRouter.evaluate,
			{
				...request,
				...expectations,
				requiredPhrases: ["  Example answer  "],
			},
			{ context: ctx },
		);
		expect(mocks.evaluate).toHaveBeenCalledExactlyOnceWith(actor, {
			executionId: EXECUTION,
			...expectations,
		});
		expect(ctx.resHeaders.get("cache-control")).toBe("private, no-store");
	});
	it.each(["inspect", "evaluate"] as const)(
		"does not echo unknown private field names in %s error or cause",
		async (operation) => {
			const marker =
				"private example recorded answer used as property name";
			const raw = {
				...request,
				...(operation === "evaluate" ? expectations : {}),
				[marker]: "private example value",
			};
			let failure: unknown;
			try {
				if (operation === "inspect") {
					await call(agentResultQualityRouter.inspect, raw, {
						context: context(),
					});
				} else {
					await call(agentResultQualityRouter.evaluate, raw, {
						context: context(),
					});
				}
			} catch (error) {
				failure = error;
			}
			expect(failure).toMatchObject({ code: "BAD_REQUEST" });
			expect(JSON.stringify(failure)).not.toContain("private example");
			expect(String(failure)).not.toContain("private example");
			expect(inspect(failure, { depth: 20 })).not.toContain(
				"private example",
			);
			expect(mocks.inspect).not.toHaveBeenCalled();
			expect(mocks.evaluate).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ userId: "example-other-user" },
		{ recordedAnswer: "Example forged answer" },
		{ retrievedSourceIds: ["example-source"] },
		{ expectedRevision: "invalid" },
		{ requiredPhrases: [] },
	])(
		"does not forward malformed authority, evidence or expectations",
		async (extra) => {
			await expect(
				call(
					agentResultQualityRouter.evaluate,
					{ ...request, ...expectations, ...extra },
					{ context: context() },
				),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(mocks.evaluate).not.toHaveBeenCalled();
		},
	);
	it.each(["inspect", "evaluate"] as const)(
		"refuses an unauthenticated %s before shared commands",
		async (operation) => {
			mocks.getSession.mockResolvedValue(null);
			if (operation === "inspect") {
				await expect(
					call(agentResultQualityRouter.inspect, request, {
						context: context(),
					}),
				).rejects.toMatchObject({ code: "UNAUTHORIZED" });
			} else {
				await expect(
					call(
						agentResultQualityRouter.evaluate,
						{ ...request, ...expectations },
						{ context: context() },
					),
				).rejects.toMatchObject({ code: "UNAUTHORIZED" });
			}
			expect(mocks.permissions).not.toHaveBeenCalled();
			expect(mocks.inspect).not.toHaveBeenCalled();
			expect(mocks.evaluate).not.toHaveBeenCalled();
		},
	);
	it.each(["inspect", "evaluate"] as const)(
		"refuses the current project role for %s",
		async (operation) => {
			mocks.permissions.mockResolvedValue({
				source: "project-member",
				organizationId: ORG,
				permissions: [],
			});
			const ctx = context();
			if (operation === "inspect") {
				await expect(
					call(agentResultQualityRouter.inspect, request, {
						context: ctx,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
			} else {
				await expect(
					call(
						agentResultQualityRouter.evaluate,
						{ ...request, ...expectations },
						{ context: ctx },
					),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
			}
			expect(ctx.resHeaders.get("cache-control")).toBe(
				"private, no-store",
			);
			expect(mocks.inspect).not.toHaveBeenCalled();
			expect(mocks.evaluate).not.toHaveBeenCalled();
		},
	);
	it("refuses a caller-selected organization different from the authorized project", async () => {
		await expect(
			call(
				agentResultQualityRouter.inspect,
				{ ...request, organizationId: "example-other-org" },
				{ context: context() },
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.inspect).not.toHaveBeenCalled();
	});
	it("refuses missing live project permissions rather than inferring them from session membership", async () => {
		mocks.permissions.mockResolvedValue(null);
		await expect(
			call(agentResultQualityRouter.inspect, request, {
				context: context(),
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.inspect).not.toHaveBeenCalled();
	});
	it("preserves safe command refusals and removes unknown backend details from the error cause", async () => {
		mocks.inspect.mockRejectedValueOnce(
			new SavedEvaluationError(
				"CONFLICT",
				"This result changed. Inspect again.",
			),
		);
		await expect(
			call(agentResultQualityRouter.inspect, request, {
				context: context(),
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		mocks.inspect.mockRejectedValueOnce(
			new Error("private example native provider detail"),
		);
		let failure: unknown;
		try {
			await call(agentResultQualityRouter.inspect, request, {
				context: context(),
			});
		} catch (error) {
			failure = error;
		}
		expect(failure).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		expect(inspect(failure, { depth: 20 })).not.toContain(
			"private example",
		);
	});
});
