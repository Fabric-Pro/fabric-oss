/**
 * Tests for setDefaultProviderProcedure — embeddings preservation on a
 * default-provider change.
 *
 * When the default AI provider changes, per-task model preferences are cleared
 * so users don't keep models that aren't available under the new provider. The
 * embeddings model, however, is pinned to the dedicated "Use for Documents"
 * provider (isEmbeddingProvider) independent of the default provider —
 * re-pointing it would invalidate already-indexed vectors. These tests verify
 * the EMBEDDING preference is excluded from the deleteMany exactly when a
 * distinct documents provider governs embeddings, in both org and personal
 * contexts. IMAGE and every other task type are always cleared.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockDb,
	mockOrgDeleteMany,
	mockUserDeleteMany,
	mockGetEmbeddingProviderConfig,
	mockRequireOrgMembership,
	mockResolveOrganizationId,
} = vi.hoisted(() => {
	const mockOrgDeleteMany = vi.fn();
	const mockUserDeleteMany = vi.fn();
	const txUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
	const mockDb = {
		cloudProviderConfig: { findFirst: vi.fn() },
		userCloudProviderConfig: { findFirst: vi.fn() },
		organizationModelPreference: { deleteMany: mockOrgDeleteMany },
		userModelPreference: { deleteMany: mockUserDeleteMany },
		$transaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
			cb({
				cloudProviderConfig: { updateMany: txUpdateMany },
				userCloudProviderConfig: { updateMany: txUpdateMany },
			}),
		),
	};
	return {
		mockDb,
		mockOrgDeleteMany,
		mockUserDeleteMany,
		mockGetEmbeddingProviderConfig: vi.fn(),
		mockRequireOrgMembership: vi.fn(),
		mockResolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? null,
		),
	};
});

vi.mock("@repo/database", () => ({
	db: mockDb,
	getEmbeddingProviderConfig: (...args: unknown[]) =>
		mockGetEmbeddingProviderConfig(...args),
	// Named imports used by sibling procedures in the module (unused here, but
	// must resolve since we import the whole module for side effects).
	ALL_EMBEDDING_CAPABLE_PROVIDERS: [],
	canProviderSupportEmbeddings: vi.fn(() => true),
	getProviderDisplayName: vi.fn((p: string) => p),
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: vi.fn((key: string) => `encrypted:${key}`),
}));

vi.mock("../../../../organizations/lib/membership", () => ({
	requireOrgMembership: (...args: unknown[]) =>
		mockRequireOrgMembership(...args),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: (schema: unknown) => {
			(chainable as { _input?: unknown })._input = schema;
			return chainable;
		},
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({
			_handler: fn,
			_input: (chainable as { _input?: unknown })._input,
		}),
	});
	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			mockResolveOrganizationId(organizationId),
		requirePermission: vi.fn(() => ({})),
		// Used at module-eval time by sibling procedures in upsert.ts (e.g.
		// getProviderConfigProcedure) that this side-effect import evaluates. The
		// mocked `.use()` ignores its argument, so a no-op factory suffices.
		requireInputOrgPermission: vi.fn(() => ({})),
		Permissions: new Proxy(
			{},
			{ get: (_, prop: string) => prop.toLowerCase() },
		),
	};
});

// Side-effect import registers the handler on the exported procedure object.
import { setDefaultProviderProcedure } from "../upsert";

type SetDefaultResult = { success: boolean; preferencesCleared: number };
const setDefault = setDefaultProviderProcedure as unknown as {
	_handler: (args: {
		input: unknown;
		context: unknown;
	}) => Promise<SetDefaultResult>;
};

const orgContext = {
	user: { id: "user-1" },
	session: { id: "s1", activeOrganizationId: "org-1" },
};
const personalContext = {
	user: { id: "user-1" },
	session: { id: "s1", activeOrganizationId: null },
};

describe("setDefaultProviderProcedure — embeddings preservation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireOrgMembership.mockResolvedValue({ role: "admin" });
		mockOrgDeleteMany.mockResolvedValue({ count: 4 });
		mockUserDeleteMany.mockResolvedValue({ count: 2 });
	});

	describe("organization context", () => {
		it("preserves EMBEDDING when a distinct documents provider governs it", async () => {
			mockDb.cloudProviderConfig.findFirst.mockResolvedValue({
				provider: "VERCEL_GATEWAY",
			});
			mockGetEmbeddingProviderConfig.mockResolvedValue({
				provider: "OPENAI_DIRECT",
			});

			const res = await setDefault._handler({
				input: {
					provider: "ANTHROPIC_DIRECT",
					organizationId: "org-1",
				},
				context: orgContext,
			});

			expect(mockGetEmbeddingProviderConfig).toHaveBeenCalledWith({
				userId: "user-1",
				organizationId: "org-1",
			});
			expect(mockOrgDeleteMany).toHaveBeenCalledTimes(1);
			expect(mockOrgDeleteMany.mock.calls[0][0].where).toEqual({
				organizationId: "org-1",
				taskType: { not: "EMBEDDING" },
			});
			expect(res.preferencesCleared).toBe(4);
		});

		it("clears EMBEDDING when the documents provider IS the new default", async () => {
			mockDb.cloudProviderConfig.findFirst.mockResolvedValue({
				provider: "VERCEL_GATEWAY",
			});
			mockGetEmbeddingProviderConfig.mockResolvedValue({
				provider: "ANTHROPIC_DIRECT",
			});

			await setDefault._handler({
				input: {
					provider: "ANTHROPIC_DIRECT",
					organizationId: "org-1",
				},
				context: orgContext,
			});

			expect(mockOrgDeleteMany.mock.calls[0][0].where).toEqual({
				organizationId: "org-1",
			});
		});

		it("clears EMBEDDING when no documents provider is configured", async () => {
			mockDb.cloudProviderConfig.findFirst.mockResolvedValue({
				provider: "VERCEL_GATEWAY",
			});
			mockGetEmbeddingProviderConfig.mockResolvedValue({
				provider: null,
			});

			await setDefault._handler({
				input: {
					provider: "ANTHROPIC_DIRECT",
					organizationId: "org-1",
				},
				context: orgContext,
			});

			expect(mockOrgDeleteMany.mock.calls[0][0].where).toEqual({
				organizationId: "org-1",
			});
		});

		it("does not clear anything when the provider is unchanged", async () => {
			mockDb.cloudProviderConfig.findFirst.mockResolvedValue({
				provider: "ANTHROPIC_DIRECT",
			});

			const res = await setDefault._handler({
				input: {
					provider: "ANTHROPIC_DIRECT",
					organizationId: "org-1",
				},
				context: orgContext,
			});

			expect(mockOrgDeleteMany).not.toHaveBeenCalled();
			expect(mockGetEmbeddingProviderConfig).not.toHaveBeenCalled();
			expect(res.preferencesCleared).toBe(0);
		});
	});

	describe("personal context", () => {
		it("preserves EMBEDDING when a distinct documents provider governs it", async () => {
			mockDb.userCloudProviderConfig.findFirst.mockResolvedValue({
				provider: "VERCEL_GATEWAY",
			});
			mockGetEmbeddingProviderConfig.mockResolvedValue({
				provider: "OPENAI_DIRECT",
			});

			const res = await setDefault._handler({
				input: { provider: "ANTHROPIC_DIRECT", organizationId: null },
				context: personalContext,
			});

			expect(mockGetEmbeddingProviderConfig).toHaveBeenCalledWith({
				userId: "user-1",
				organizationId: null,
			});
			expect(mockUserDeleteMany).toHaveBeenCalledTimes(1);
			expect(mockUserDeleteMany.mock.calls[0][0].where).toEqual({
				userId: "user-1",
				taskType: { not: "EMBEDDING" },
			});
			expect(res.preferencesCleared).toBe(2);
		});

		it("clears EMBEDDING when no documents provider is configured", async () => {
			mockDb.userCloudProviderConfig.findFirst.mockResolvedValue({
				provider: "VERCEL_GATEWAY",
			});
			mockGetEmbeddingProviderConfig.mockResolvedValue({
				provider: null,
			});

			await setDefault._handler({
				input: { provider: "ANTHROPIC_DIRECT", organizationId: null },
				context: personalContext,
			});

			expect(mockUserDeleteMany.mock.calls[0][0].where).toEqual({
				userId: "user-1",
			});
		});
	});
});
