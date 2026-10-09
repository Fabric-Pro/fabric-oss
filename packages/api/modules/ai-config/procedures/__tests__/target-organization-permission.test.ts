/**
 * Organization-level procedures that act on a caller-named organization check
 * the caller's permission IN THAT organization (Fizzy #2904), not the session's.
 *
 * Each was gated by `requirePermission`, which evaluates the session's role —
 * so a member of one organization could name another and run an agent preview
 * on its AI provider, learn whether it has a provider configured, or read its
 * RAG and search providers (masked key, endpoint, usage). Exercised through the
 * real procedure chain; only I/O is mocked.
 */
import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_MEMBER = "org-example-member";
const ORG_OTHER = "org-example-other";
const USER_ID = "user-example-1";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	getOrganizationMembership: vi.fn(),
	previewAgentTurn: vi.fn(),
	getAiProviderApiKey: vi.fn(),
	getOrganizationRagProviders: vi.fn(),
	getOrganizationSearchProviders: vi.fn(),
}));

const { passThrough } = vi.hoisted(() => ({
	passThrough: async () => {
		const { os } = await import("@orpc/server");
		return os.middleware(async ({ next }) => next());
	},
}));

vi.mock("@repo/payments", () => ({}));
vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: (...a: unknown[]) => mocks.getSession(...a) } },
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@repo/temporal/activities", () => ({
	previewAgentTurn: (...a: unknown[]) => mocks.previewAgentTurn(...a),
}));
vi.mock("@repo/database", () => ({
	db: {},
	getTenantContext: () => ({ effectiveWriteOrgId: null }),
	getOrganizationMembership: (...a: unknown[]) =>
		mocks.getOrganizationMembership(...a),
	grantProjectAccess: vi.fn(),
	StoryVersionConflictError: class extends Error {},
	getAiProviderApiKey: (...a: unknown[]) => mocks.getAiProviderApiKey(...a),
	getEmbeddingProviderConfig: vi.fn(async () => ({ provider: null })),
	getUserModelPreferences: vi.fn(async () => []),
	getModelByCanonicalName: vi.fn(async () => null),
	isGatewayProvider: () => true,
	deleteUserModelPreference: vi.fn(),
	deleteUserModelPreferencesByTaskType: vi.fn(),
	setUserModelPreference: vi.fn(),
	getOrganizationRagProviders: (...a: unknown[]) =>
		mocks.getOrganizationRagProviders(...a),
	getUserRagProviders: vi.fn(async () => []),
	getOrganizationSearchProviders: (...a: unknown[]) =>
		mocks.getOrganizationSearchProviders(...a),
	getUserSearchProviders: vi.fn(async () => []),
	getOrganizationFirecrawlConfig: vi.fn(async () => null),
	getUserFirecrawlConfig: vi.fn(async () => null),
}));
vi.mock("../../../../lib/rate-limit", () => ({
	checkRateLimit: async () => ({ allowed: true }),
	RATE_LIMIT_PRESETS: {},
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

import { previewDraftAgent } from "../../../agents/procedures/preview-draft-agent";
import { getUserProviders as getUserRagProviders } from "../../../rag-providers/procedures/get-user-providers";
import { getUserProviders as getUserSearchProviders } from "../../../search-providers/procedures/get-user-providers";
import { getUserModelPreferencesProcedure } from "../preferences/get-user";
import {
	deleteUserModelPreferenceProcedure,
	setUserModelPreferenceProcedure,
} from "../preferences/set-user";

const context = { headers: new Headers() };

beforeEach(() => {
	vi.clearAllMocks();
	// The session is in the organization the caller administers.
	mocks.getSession.mockResolvedValue({
		session: { activeOrganizationId: ORG_MEMBER },
		user: { id: USER_ID },
	});
	mocks.getOrganizationMembership.mockImplementation(
		async (organizationId: string) =>
			organizationId === ORG_MEMBER ? { role: "owner" } : null,
	);
	mocks.previewAgentTurn.mockResolvedValue({ response: "ok", success: true });
	mocks.getAiProviderApiKey.mockResolvedValue({ provider: "OPENAI" });
	mocks.getOrganizationRagProviders.mockResolvedValue([]);
	mocks.getOrganizationSearchProviders.mockResolvedValue([]);
});

describe("a caller naming an organization they do not belong to is refused before the handler", () => {
	it("agent preview — no AI turn on that organization's provider", async () => {
		await expect(
			call(
				previewDraftAgent,
				{
					systemPrompt: "s",
					userMessage: "u",
					organizationId: ORG_OTHER,
				},
				{ context },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.previewAgentTurn).not.toHaveBeenCalled();
	});

	it("setting a model preference — that organization's provider is never read", async () => {
		await expect(
			call(
				setUserModelPreferenceProcedure,
				{
					taskType: "CHAT",
					modelCanonicalName: "example-model",
					organizationId: ORG_OTHER,
				},
				{ context },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.getAiProviderApiKey).not.toHaveBeenCalled();
	});

	it("reading model preferences — no oracle for whether it has a provider", async () => {
		await expect(
			call(
				getUserModelPreferencesProcedure,
				{ organizationId: ORG_OTHER },
				{ context },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.getAiProviderApiKey).not.toHaveBeenCalled();
	});

	it("RAG providers — its masked keys and usage are not returned", async () => {
		await expect(
			call(
				getUserRagProviders,
				{ organizationId: ORG_OTHER },
				{ context },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.getOrganizationRagProviders).not.toHaveBeenCalled();
	});

	it("search providers — its masked keys and usage are not returned", async () => {
		await expect(
			call(
				getUserSearchProviders,
				{ organizationId: ORG_OTHER },
				{ context },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.getOrganizationSearchProviders).not.toHaveBeenCalled();
	});
});

describe("the role is evaluated in the named organization", () => {
	it("refuses a plain member there for an admin-only setting, whatever the session role", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "member" });
		await expect(
			call(
				setUserModelPreferenceProcedure,
				{
					taskType: "CHAT",
					modelCanonicalName: "example-model",
					organizationId: ORG_OTHER,
				},
				{ context },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
			ORG_OTHER,
			USER_ID,
		);
	});

	it("still serves the caller's own organization", async () => {
		await expect(
			call(
				previewDraftAgent,
				{
					systemPrompt: "s",
					userMessage: "u",
					organizationId: ORG_MEMBER,
				},
				{ context },
			),
		).resolves.toMatchObject({ success: true });
		expect(mocks.previewAgentTurn).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: ORG_MEMBER }),
		);
	});
});

// Fizzy #2904 review: with a null organization nothing resolves, and without
// `requireOrganization` the role check was skipped entirely.
describe("a null organization", () => {
	beforeEach(() => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "viewer" });
	});

	it("is refused for an agent preview — no AI turn in personal context", async () => {
		await expect(
			call(
				previewDraftAgent,
				{ systemPrompt: "s", userMessage: "u", organizationId: null },
				{ context },
			),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			data: { errorCode: "MISSING_ORGANIZATION_CONTEXT" },
		});
		expect(mocks.previewAgentTurn).not.toHaveBeenCalled();
	});

	it.each([
		[
			"setting",
			() => setUserModelPreferenceProcedure,
			{ taskType: "CHAT", modelCanonicalName: "example-model" },
		],
		[
			"deleting",
			() => deleteUserModelPreferenceProcedure,
			{ taskType: "CHAT" },
		],
	] as const)(
		"is refused for %s a model preference by a viewer — no provider read",
		async (_label, procedure, input) => {
			await expect(
				call(
					procedure(),
					{ ...input, organizationId: null },
					{ context },
				),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.getAiProviderApiKey).not.toHaveBeenCalled();
		},
	);

	it("passes through for reading the caller's own personal preferences", async () => {
		await call(
			getUserModelPreferencesProcedure,
			{ organizationId: null },
			{ context },
		);
		expect(mocks.getAiProviderApiKey).toHaveBeenCalledWith({
			userId: USER_ID,
			organizationId: undefined,
		});
	});
});

describe("a soft-deleted organization the caller still belongs to", () => {
	it("is refused for an agent preview — no AI turn on its provider", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({
			role: "owner",
			organization: { id: ORG_OTHER, deletedAt: new Date("2026-09-01") },
		});
		await expect(
			call(
				previewDraftAgent,
				{
					systemPrompt: "s",
					userMessage: "u",
					organizationId: ORG_OTHER,
				},
				{ context },
			),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			data: { errorCode: "ORGANIZATION_DELETED" },
		});
		expect(mocks.previewAgentTurn).not.toHaveBeenCalled();
	});
});
