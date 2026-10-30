import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	counts: vi.fn(),
	list: vi.fn(),
}));

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
	getOrganizations: mocks.list,
	countAllOrganizations: mocks.counts,
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

import { listOrganizations } from "../list-organizations";

const invoke = (input = {}) =>
	call(listOrganizations, input, { context: { headers: new Headers() } });
beforeEach(() => {
	vi.clearAllMocks();
	mocks.getSession.mockResolvedValue({
		session: {},
		user: { id: "example-admin", role: "admin" },
	});
	mocks.list.mockResolvedValue([]);
	mocks.counts.mockResolvedValue(0);
});
describe("organization list", () => {
	it("requires authentication", async () => {
		mocks.getSession.mockResolvedValue(null);
		await expect(invoke()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.list).not.toHaveBeenCalled();
	});
	it("requires instance admin", async () => {
		mocks.getSession.mockResolvedValue({
			session: {},
			user: { id: "example-user", role: "user" },
		});
		await expect(invoke()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.list).not.toHaveBeenCalled();
	});
	it.each([
		{ limit: 0 },
		{ limit: 101 },
		{ offset: -1 },
		{ offset: 0.5 },
		{ sort: "unknown" },
		{ direction: "unknown" },
		{ status: "unknown" },
	])("rejects invalid input %j", async (input) => {
		await expect(invoke(input)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});
	it("forwards filters and sorting to both queries", async () => {
		const input = {
			limit: 8,
			offset: 8,
			query: "example",
			status: "deactivated",
			sort: "projects",
			direction: "asc",
		};
		await invoke(input);
		expect(mocks.list).toHaveBeenCalledWith(input);
		expect(mocks.counts).toHaveBeenCalledWith(input);
	});
});
