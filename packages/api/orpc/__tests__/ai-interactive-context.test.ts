/**
 * Every authenticated oRPC call is a person's own browser request, so the
 * session middleware marks its AI work interactive: it may run on that
 * person's ChatGPT plan without the procedure passing `planEligible`
 * (Fizzy #2939). The marker belongs to the session's user only, and is not
 * set while an admin impersonates them.
 */
import { call } from "@orpc/server";
import {
	isAiImpersonatedRequest,
	isAiInteractiveRequestFor,
} from "@repo/ai/lib/chatgpt-plan/interactive-context";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock("@repo/payments", () => ({}));
vi.mock("@repo/config", () => ({ config: {} }));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: (...a: unknown[]) => mocks.getSession(...a) } },
}));
vi.mock("@repo/database", () => ({
	db: {},
	getTenantContext: () => ({ effectiveWriteOrgId: null }),
	StoryVersionConflictError: class extends Error {},
}));
vi.mock("../../lib/rate-limit", () => ({
	checkRateLimit: async () => ({
		allowed: true,
		remaining: 1,
		resetInSeconds: 60,
	}),
	RATE_LIMIT_PRESETS: {},
}));

const { passThrough } = vi.hoisted(() => ({
	passThrough: async () => {
		const { os: orpc } = await import("@orpc/server");
		return orpc.middleware(async ({ next }) => next());
	},
}));
vi.mock("../middleware/request-counter-middleware", async () => ({
	requestCounterMiddleware: await passThrough(),
}));
vi.mock("../middleware/error-metrics-middleware", async () => ({
	errorMetricsMiddleware: await passThrough(),
}));
vi.mock("../middleware/audit-error-middleware", async () => ({
	auditErrorMiddleware: await passThrough(),
}));
vi.mock("../middleware/audit-timing-middleware", async () => ({
	auditTimingMiddleware: await passThrough(),
}));
vi.mock("../middleware/audit-activity-middleware", async () => ({
	auditActivityMiddleware: await passThrough(),
}));
vi.mock("../middleware/touch-last-seen", async () => ({
	touchLastSeenMiddleware: await passThrough(),
}));
vi.mock("../middleware/rpc-rate-limit-middleware", async () => ({
	rpcRateLimitMiddleware: await passThrough(),
}));
vi.mock("../middleware/tenant-context-middleware", async () => ({
	tenantContextMiddleware: await passThrough(),
	getOrganizationIdFromContext: vi.fn(),
	getTenantFilterFromContext: vi.fn(),
}));

import { protectedProcedure, publicProcedure } from "../procedures";

// Awaits first, so the check runs in a later async continuation of the
// handler, as an AI call deep inside a procedure would.
const probe = protectedProcedure.handler(async ({ context }) => {
	await Promise.resolve();
	return {
		self: isAiInteractiveRequestFor(context.user.id),
		other: isAiInteractiveRequestFor("user-other"),
		impersonated: isAiImpersonatedRequest(),
	};
});

const publicProbe = publicProcedure.handler(async () =>
	isAiInteractiveRequestFor("user-1"),
);

const callWithSession = (procedure: typeof probe) =>
	call(procedure, undefined, { context: { headers: new Headers() } });

beforeEach(() => {
	mocks.getSession.mockReset();
	mocks.getSession.mockResolvedValue({
		session: { activeOrganizationId: null, impersonatedBy: null },
		user: { id: "user-1" },
	});
});

describe("the oRPC session middleware's interactive marker", () => {
	it("marks the session user's AI work interactive inside the procedure", async () => {
		await expect(callWithSession(probe)).resolves.toEqual({
			self: true,
			other: false,
			impersonated: false,
		});
	});

	it("does not mark anything outside the request", async () => {
		await callWithSession(probe);
		expect(isAiInteractiveRequestFor("user-1")).toBe(false);
	});

	it("does not mark a public procedure", async () => {
		await expect(
			call(publicProbe, undefined, {
				context: { headers: new Headers() },
			}),
		).resolves.toBe(false);
	});

	it("marks an impersonated session as impersonated, never as the member's own", async () => {
		mocks.getSession.mockResolvedValue({
			session: { activeOrganizationId: null, impersonatedBy: "admin-1" },
			user: { id: "user-1" },
		});
		await expect(callWithSession(probe)).resolves.toEqual({
			self: false,
			other: false,
			impersonated: true,
		});
	});
});

describe("a ChatGPT plan refusal anywhere in a protected procedure", () => {
	it("reaches the client as the reconnect error, not a generic failure", async () => {
		const { ChatGptPlanAuthError } = await import(
			"@repo/ai/lib/chatgpt-plan/oauth"
		);
		const refusing = protectedProcedure.handler(async () => {
			throw new ChatGptPlanAuthError(
				"Reconnect",
				"needs_reconnect",
				true,
			);
		});
		await expect(
			call(refusing, undefined, { context: { headers: new Headers() } }),
		).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			data: { code: "CHATGPT_PLAN_UNAVAILABLE" },
		});
	});
});
