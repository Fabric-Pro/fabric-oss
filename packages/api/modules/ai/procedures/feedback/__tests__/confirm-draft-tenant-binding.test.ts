import { call } from "@orpc/server";
import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	resolveEffectiveProjectPermissions: vi.fn(),
	write: vi.fn(),
	grantProjectAccess: vi.fn(),
	getOrganizationMembership: vi.fn(),
	hasOrganizationTie: vi.fn(),
	getSession: vi.fn(),
	effectiveWriteOrgId: null as string | null,
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
	db: {},
	recordAiOutcome: mocks.write,
	getTenantContext: () => ({
		effectiveWriteOrgId: mocks.effectiveWriteOrgId,
	}),
	getOrganizationMembership: (...a: unknown[]) =>
		mocks.getOrganizationMembership(...a),
	grantProjectAccess: (...a: unknown[]) => mocks.grantProjectAccess(...a),
	hasOrganizationTie: (...a: unknown[]) => mocks.hasOrganizationTie(...a),
	StoryVersionConflictError: class extends Error {},
}));
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...a: unknown[]) =>
		mocks.resolveEffectiveProjectPermissions(...a),
}));
vi.mock("../../../../../lib/rate-limit", () => ({
	checkRateLimit: async () => ({
		allowed: true,
		remaining: 1,
		resetInSeconds: 60,
	}),
	RATE_LIMIT_PRESETS: {},
}));

// The observability and audit middlewares are not what these tests are about,
// and each reaches a database; pass them through so the chain under test is
// the REAL root → session → permission → handler order.
const { passThrough } = vi.hoisted(() => ({
	passThrough: async () => {
		const { os: orpc } = await import("@orpc/server");
		return orpc.middleware(async ({ next }) => next());
	},
}));
vi.mock(
	"../../../../../orpc/middleware/request-counter-middleware",
	async () => ({
		requestCounterMiddleware: await passThrough(),
	}),
);
vi.mock(
	"../../../../../orpc/middleware/error-metrics-middleware",
	async () => ({
		errorMetricsMiddleware: await passThrough(),
	}),
);
vi.mock(
	"../../../../../orpc/middleware/audit-error-middleware",
	async (importOriginal) => ({
		// The real `auditOrganizationId` is under test below.
		...(await importOriginal<
			typeof import("../../../../../orpc/middleware/audit-error-middleware")
		>()),
		auditErrorMiddleware: await passThrough(),
	}),
);
vi.mock("../../../../../orpc/middleware/audit-timing-middleware", async () => ({
	auditTimingMiddleware: await passThrough(),
}));
vi.mock(
	"../../../../../orpc/middleware/audit-activity-middleware",
	async () => ({
		auditActivityMiddleware: await passThrough(),
	}),
);
vi.mock("../../../../../orpc/middleware/touch-last-seen", async () => ({
	touchLastSeenMiddleware: await passThrough(),
}));
vi.mock(
	"../../../../../orpc/middleware/rpc-rate-limit-middleware",
	async () => ({
		rpcRateLimitMiddleware: await passThrough(),
	}),
);
vi.mock(
	"../../../../../orpc/middleware/tenant-context-middleware",
	async () => ({
		tenantContextMiddleware: await passThrough(),
		getOrganizationIdFromContext: vi.fn(),
		getTenantFilterFromContext: vi.fn(),
	}),
);

import { confirmAiDraft } from "../confirm-draft";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.effectiveWriteOrgId = null;
	mocks.getSession.mockResolvedValue({
		session: { activeOrganizationId: "example-session-org" },
		user: { id: "example-user" },
	});
	mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
		source: "project-member",
		organizationId: "example-project-org",
		permissions: [Permissions.PROJECT_UPDATE],
	});
});

describe("confirm draft real project organization binding", () => {
	it("files an invited guest's verdict under the project's organization rather than the active session organization", async () => {
		await call(
			confirmAiDraft,
			{
				surface: "document",
				projectId: "example-project",
				draftId: "example-draft",
				verdict: "rejected",
			},
			{ context: { headers: new Headers() } },
		);
		expect(mocks.write).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "example-project-org",
				projectId: "example-project",
				userId: "example-user",
			}),
		);
		expect(mocks.grantProjectAccess).toHaveBeenCalledWith(
			"example-project",
			"example-project-org",
		);
	});
});
