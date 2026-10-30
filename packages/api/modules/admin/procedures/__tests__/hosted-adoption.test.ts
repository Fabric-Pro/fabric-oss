import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), counts: vi.fn() }));

vi.mock("@repo/payments", () => ({}));
vi.mock("@repo/config", () => ({ config: {} }));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: (...a: unknown[]) => mocks.getSession(...a) } },
}));
vi.mock("@repo/database", () => ({
	isPlatformAdmin: async (user: { role?: string | null }) =>
		user.role === "admin",
	db: {},
	getHostedAdoptionCounts: mocks.counts,
	getTenantContext: () => ({ effectiveWriteOrgId: null }),
	StoryVersionConflictError: class extends Error {},
}));
vi.mock("../../../../lib/rate-limit", () => ({
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

import { getHostedAdoptionCountsProcedure } from "../hosted-adoption";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.counts.mockResolvedValue({
		organizations: 2,
		projects: 4,
		users: 3,
		ignored: "example-org",
	});
});
const invoke = () =>
	call(getHostedAdoptionCountsProcedure, undefined, {
		context: { headers: new Headers() },
	});
describe("hosted adoption authorization", () => {
	it("rejects unauthenticated requests before counting", async () => {
		mocks.getSession.mockResolvedValue(null);
		await expect(invoke()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.counts).not.toHaveBeenCalled();
	});
	it("rejects non-admin requests before counting", async () => {
		mocks.getSession.mockResolvedValue({
			session: {},
			user: { id: "example-user", role: "user" },
		});
		await expect(invoke()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.counts).not.toHaveBeenCalled();
	});
	it("returns exactly three counts for admins", async () => {
		mocks.getSession.mockResolvedValue({
			session: {},
			user: { id: "example-admin", role: "admin" },
		});
		const result = await invoke();
		expect(result).toEqual({ organizations: 2, projects: 4, users: 3 });
		expect(Object.keys(result).sort()).toEqual([
			"organizations",
			"projects",
			"users",
		]);
	});
});
