import { call } from "@orpc/server";
import type { Organization } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	member: vi.fn(),
	limit: vi.fn(),
}));

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
	...(await import("../../../database/prisma/queries/organizations")),
	isPlatformAdmin: vi.fn(),
	db: {},
	getTenantContext: () => ({ effectiveWriteOrgId: null }),
	StoryVersionConflictError: class extends Error {},
}));
vi.mock("../../lib/rate-limit", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/rate-limit")>()),
	checkRateLimit: mocks.limit,
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

import { RATE_LIMIT_PRESETS } from "../../lib/rate-limit";
import {
	agentRateLimitedProcedure,
	aiRateLimitedProcedure,
	enforceAiRateLimit,
	enforceWorkflowRateLimit,
	rateLimitedProcedure,
	rateLimitedPublicProcedure,
	requireOrganizationAdmin,
	requireOrganizationMembership,
	workflowRateLimitedProcedure,
} from "../procedures";

const userId = "example-user";
const organizationId = "example-org";
const createdAt = new Date("2026-01-10T00:00:00Z");
const organization = {
	id: organizationId,
	name: "Example Org",
	slug: null,
	logo: null,
	createdAt: createdAt,
	metadata: null,
	paymentsCustomerId: null,
	timezone: null,
	azureAiApiKey: null,
	azureAiConfiguredAt: null,
	azureAiEnabled: false,
	azureAiEndpoint: null,
	azureAiLastUsedAt: null,
	azureAiModelRouterName: null,
	azureAiProjectName: null,
	azureAiRegion: null,
	azureAiResourceGroup: null,
	azureAiSubscriptionId: null,
	azureAiTenantId: null,
	azureAiUseModelRouter: false,
	useDelegatedExecution: true,
	documentAssistantHistoryEnabled: true,
	featureMaturationV2Enabled: true,
	aiAnswerRecommendationsEnabled: false,
	requireTwoFactor: false,
	attachmentRetentionDays: null,
	attachmentRetentionDaysUpdatedAt: null,
	timeRequireStartStop: false,
	timeDefaultBillable: null,
	deletedAt: null,
	deletedBy: null,
	scheduledPermanentDeleteAt: null,
	deletionReminderSentAt: null,
	instructionTemplateProjectId: null,
	canShareFramesPublicly: true,
} satisfies Organization;
const probeResult = "handler reached";
const path = ["example"];
const clientIp = "192.0.2.10";
const context = {
	headers: new Headers({ "x-vercel-forwarded-for": clientIp }),
};
const allowed = { allowed: true, remaining: 1, resetInSeconds: 9 };
const exceeded = {
	allowed: false,
	remaining: 0,
	resetInSeconds: 9,
	statusCode: 429,
};
const unavailable = { ...exceeded, statusCode: 503 };

beforeEach(() => {
	vi.resetAllMocks();
	mocks.getSession.mockResolvedValue({
		session: { activeOrganizationId: organizationId },
		user: { id: userId },
	});
	mocks.limit.mockResolvedValue(allowed);
	mocks.member.mockImplementation(async ({ where }) => {
		const lookup = where.organizationId_userId;
		return lookup.organizationId === organizationId &&
			lookup.userId === userId
			? {
					id: "example-member",
					role: "member",
					organizationId,
					userId,
					createdAt,
					organization,
				}
			: null;
	});
});

it("requires membership in the requested organization", async () => {
	await expect(
		requireOrganizationMembership("other-org", userId),
	).rejects.toMatchObject({
		code: "FORBIDDEN",
		message: "You are not a member of this organization",
	});
	expect(mocks.member).toHaveBeenCalledExactlyOnceWith({
		where: {
			organizationId_userId: { organizationId: "other-org", userId },
		},
		include: { organization: true },
	});
});

it("returns the member's role and organization with no role restriction", async () => {
	await expect(
		requireOrganizationMembership(organizationId, userId),
	).resolves.toEqual({ organization, role: "member" });
	await expect(
		requireOrganizationMembership(organizationId, userId, []),
	).resolves.toEqual({ organization, role: "member" });
});

it("refuses an ordinary member at the organization admin gate", async () => {
	await expect(
		requireOrganizationAdmin(organizationId, userId),
	).rejects.toMatchObject({
		code: "FORBIDDEN",
		message: "You do not have the required role in this organization",
	});
});

it.each(["admin", "owner"])(
	"admits an organization %s at the admin gate",
	async (role) => {
		mocks.member.mockResolvedValue({
			organization,
			role,
			organizationId,
			userId,
			id: "example-member",
			createdAt,
		});
		await expect(
			requireOrganizationAdmin(organizationId, userId),
		).resolves.toEqual({ organization, role });
	},
);

describe.each([
	{ enforce: enforceAiRateLimit, key: "ai", label: "AI" },
	{ enforce: enforceWorkflowRateLimit, key: "workflow", label: "Workflow" },
] as const)("$label limiter", ({ enforce, key, label }) => {
	it("uses the supplied budget for this caller and path", async () => {
		await expect(
			enforce(userId, path, { limit: 2, windowMs: 7000 }),
		).resolves.toBeUndefined();
		expect(mocks.limit).toHaveBeenCalledExactlyOnceWith(
			`${key}:${userId}:example`,
			2,
			7000,
		);
	});

	it("reports an exceeded budget separately from an unavailable limiter", async () => {
		mocks.limit
			.mockResolvedValueOnce(exceeded)
			.mockResolvedValueOnce(unavailable);
		await expect(enforce(userId, path)).rejects.toMatchObject({
			code: "TOO_MANY_REQUESTS",
			message: `${label} rate limit exceeded. Please try again in 9 seconds.`,
			...(key === "workflow" ? { data: { retryAfter: 9 } } : {}),
		});
		await expect(enforce(userId, path)).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
			message: "Rate limit service temporarily unavailable",
		});
	});
});

const builders = [
	{
		build: rateLimitedPublicProcedure,
		key: "public",
		preset: RATE_LIMIT_PRESETS.public,
	},
	{
		build: rateLimitedProcedure,
		key: "user",
		preset: RATE_LIMIT_PRESETS.standard,
	},
	{ build: aiRateLimitedProcedure, key: "ai", preset: RATE_LIMIT_PRESETS.ai },
	{
		build: workflowRateLimitedProcedure,
		key: "workflow",
		preset: RATE_LIMIT_PRESETS.workflow,
	},
	{
		build: agentRateLimitedProcedure,
		key: "agent",
		preset: RATE_LIMIT_PRESETS.agent,
	},
];

describe.each(builders)("$key procedure limiter", ({ build, key, preset }) => {
	const handler = vi.fn(() => probeResult);
	const invoke = () =>
		call(build.handler(handler), undefined, { context, path });

	it("returns the handler result after checking the correct budget", async () => {
		// resetAllMocks clears the handler's calls between cases.
		await expect(invoke()).resolves.toBe(probeResult);
		expect(handler).toHaveBeenCalledOnce();
		expect(mocks.limit).toHaveBeenCalledExactlyOnceWith(
			key === "public"
				? `public:${clientIp}:example`
				: `${key}:${userId}:example`,
			preset.limit,
			preset.windowMs,
		);
	});

	it.each([
		{ result: exceeded, code: "TOO_MANY_REQUESTS" },
		{ result: unavailable, code: "SERVICE_UNAVAILABLE" },
	])("blocks the handler with $code", async ({ result, code }) => {
		mocks.limit.mockResolvedValue(result);
		await expect(invoke()).rejects.toMatchObject({ code });
		expect(handler).not.toHaveBeenCalled();
	});
});
