/** Platform admin RPCs require the exact admin role and operator membership. */
import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), member: vi.fn() }));

vi.mock("@repo/payments", () => ({}));
vi.mock("@repo/config", () => ({ config: {} }));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: (...a: unknown[]) => mocks.getSession(...a) } },
}));
vi.mock("../../../database/prisma/client", () => ({
	db: { member: { findUnique: mocks.member } },
}));
vi.mock("../../../database/prisma/queries/audit-log", () => ({
	recordAuditTx: vi.fn(),
}));
vi.mock("@repo/database", async () => ({
	...(await import("../../../database/prisma/queries/platform-admin")),
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

import { adminProcedure } from "../procedures";

const probe = adminProcedure.handler(() => "allowed");
beforeEach(() => {
	vi.stubEnv("OPERATOR_ORGANIZATION_ID", "example-org");
	mocks.member.mockReset();
	mocks.getSession.mockResolvedValue({
		session: { activeOrganizationId: "example-org" },
		user: { id: "example-user", role: "admin" },
	});
});
afterEach(() => vi.unstubAllEnvs());
describe("operator adminProcedure", () => {
	it("refuses a non-member admin", async () => {
		await expect(
			call(probe, undefined, { context: { headers: new Headers() } }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("allows a member admin", async () => {
		mocks.member.mockResolvedValue({ id: "example-member" });
		await expect(
			call(probe, undefined, { context: { headers: new Headers() } }),
		).resolves.toBe("allowed");
	});
});

it.each(["", "example-org"])(
	"refuses combined caller roles with setting %s",
	async (setting) => {
		vi.stubEnv("OPERATOR_ORGANIZATION_ID", setting);
		mocks.member.mockResolvedValue({ id: "example-member" });
		mocks.getSession.mockResolvedValue({
			session: { activeOrganizationId: "example-org" },
			user: { id: "example-user", role: "admin,user" },
		});
		await expect(
			call(probe, undefined, { context: { headers: new Headers() } }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	},
);
