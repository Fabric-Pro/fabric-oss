/**
 * Tests for `canResolveProvider` on the AI config status procedure.
 *
 * The notice this field feeds and the refusal a user actually gets have to
 * agree on what "configured" means, and `isConfigured` does not: it counts the
 * organization's enabled rows and nothing else. That diverges from the resolver
 * in BOTH directions (Fizzy #1875, R11):
 *
 * - An enabled row saved without a credential is counted as configured, while
 *   the resolver returns nothing for it — so an organization could be refused
 *   AI with no notice explaining why.
 * - A member's own personal key resolves inside an organization that has none,
 *   while `isConfigured` never looks at it — so someone whose AI works was
 *   told it could not run.
 *
 * `isConfigured` keeps its meaning (it describes the TENANT, and the settings
 * form reads it as such). `canResolveProvider` is the new field, and it
 * describes the CALLER.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mockGetModelForTask, mockResolveOrganizationId } = vi.hoisted(
	() => ({
		mockDb: {
			cloudProviderConfig: { findMany: vi.fn() },
			userCloudProviderConfig: { findMany: vi.fn() },
		},
		mockGetModelForTask: vi.fn(),
		mockResolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? null,
		),
	}),
);

vi.mock("@repo/database", () => ({
	db: mockDb,
	getModelForTask: (...args: unknown[]) => mockGetModelForTask(...args),
	getProviderDisplayName: (provider: string) => provider,
	isGatewayProvider: () => false,
	// The real reader — it is half of what is under test here. Restated rather
	// than imported because the rest of this mock exists to keep Prisma out of
	// the test. Both halves of the rule it mirrors are pinned at the source, so
	// a drift here fails there: the legacy `config.apiKey` fallback in
	// `packages/database/__tests__/ai-gateway-legacy-config-key.test.ts`, and
	// the OAuth-only row that carries no key yet is configured in
	// `ai-gateway-service-principal.test.ts`.
	readProviderRowCredentials: (row: {
		encryptedApiKey: string | null;
		clientId: string | null;
		encryptedClientSecret: string | null;
		config: unknown;
	}) => {
		const configData = (row.config as Record<string, unknown>) || {};
		const apiKey =
			row.encryptedApiKey ||
			(configData?.apiKey as string | undefined) ||
			null;
		return {
			apiKey,
			hasCredentials: Boolean(
				apiKey || (row.clientId && row.encryptedClientSecret),
			),
		};
	},
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			mockResolveOrganizationId(organizationId),
		requireInputOrgPermission: vi.fn(() => ({})),
		Permissions: new Proxy(
			{},
			{ get: (_, prop: string) => prop.toLowerCase() },
		),
	};
});

import { getAiConfigStatusProcedure } from "../get-status";

type StatusResult = { isConfigured: boolean; canResolveProvider: boolean };
const getStatus = getAiConfigStatusProcedure as unknown as {
	_handler: (args: {
		input: unknown;
		context: unknown;
	}) => Promise<StatusResult>;
};

const context = {
	user: { id: "user-1" },
	session: { id: "s1", activeOrganizationId: "org-1" },
};

/** A provider row as the procedure reads it. Credential fields default empty. */
function row(overrides: Record<string, unknown> = {}) {
	return {
		provider: "OPENAI",
		displayName: null,
		isDefault: true,
		isEmbeddingProvider: false,
		encryptedApiKey: null,
		clientId: null,
		encryptedClientSecret: null,
		config: {},
		...overrides,
	};
}

function callInOrg() {
	return getStatus._handler({
		input: { organizationId: "org-1" },
		context,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mockDb.cloudProviderConfig.findMany.mockResolvedValue([]);
	mockDb.userCloudProviderConfig.findMany.mockResolvedValue([]);
	mockGetModelForTask.mockResolvedValue(null);
});

describe("canResolveProvider — the credential gap", () => {
	it("an organization whose only enabled row carries no credential is configured but NOT resolvable", async () => {
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([row()]);

		const result = await callInOrg();

		expect(result.isConfigured).toBe(true);
		expect(result.canResolveProvider).toBe(false);
	});

	it("a row with an encrypted key resolves", async () => {
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([
			row({ encryptedApiKey: "encrypted:sk-test" }),
		]);

		expect((await callInOrg()).canResolveProvider).toBe(true);
	});

	it("a legacy row whose key still lives in `config.apiKey` resolves", async () => {
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([
			row({ config: { apiKey: "encrypted:sk-legacy" } }),
		]);

		expect((await callInOrg()).canResolveProvider).toBe(true);
	});

	it("an OAuth-only service-principal row resolves despite a null key", async () => {
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([
			row({
				provider: "DATABRICKS",
				clientId: "client-abc",
				encryptedClientSecret: "encrypted:secret-xyz",
			}),
		]);

		expect((await callInOrg()).canResolveProvider).toBe(true);
	});

	it("a half-configured service principal does not resolve", async () => {
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([
			row({ provider: "DATABRICKS", clientId: "client-abc" }),
		]);

		expect((await callInOrg()).canResolveProvider).toBe(false);
	});
});

describe("canResolveProvider — the personal-key gap", () => {
	it("a member's own key inside an organization with none makes AI resolvable", async () => {
		mockDb.userCloudProviderConfig.findMany.mockResolvedValue([
			row({ encryptedApiKey: "encrypted:sk-personal" }),
		]);

		const result = await callInOrg();

		// The organization itself is still unconfigured — that field describes
		// the tenant and must not move.
		expect(result.isConfigured).toBe(false);
		expect(result.canResolveProvider).toBe(true);
	});

	it("reads only the CALLER's own rows, never another member's", async () => {
		await callInOrg();

		// `isDefault` joined this clause when the field was corrected to mirror
		// the resolver, which reads only the default row. The part that matters
		// here is unchanged: the query is scoped to this caller's `userId`, so
		// no other member's configuration is ever read.
		expect(mockDb.userCloudProviderConfig.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { userId: "user-1", isDefault: true, enabled: true },
			}),
		);
	});

	it("does not reach for personal rows when the organization already resolves", async () => {
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([
			row({ encryptedApiKey: "encrypted:sk-org" }),
		]);

		await callInOrg();

		expect(mockDb.userCloudProviderConfig.findMany).not.toHaveBeenCalled();
	});

	it("a personal row with no credential does not rescue an organization with none", async () => {
		mockDb.userCloudProviderConfig.findMany.mockResolvedValue([row()]);

		expect((await callInOrg()).canResolveProvider).toBe(false);
	});
});

describe("canResolveProvider — outside an organization", () => {
	it("answers from the caller's own rows and never reads an organization's", async () => {
		mockDb.userCloudProviderConfig.findMany.mockResolvedValue([
			row({ encryptedApiKey: "encrypted:sk-personal" }),
		]);

		const result = await getStatus._handler({
			input: { organizationId: null },
			context: { user: { id: "user-1" }, session: { id: "s1" } },
		});

		expect(result.canResolveProvider).toBe(true);
		expect(mockDb.cloudProviderConfig.findMany).not.toHaveBeenCalled();
	});
});

describe("canResolveProvider — the row the resolver actually reads", () => {
	it("a credentialed NON-default row does not make an organization resolvable", async () => {
		// The resolver issues `findFirst({ isDefault: true, enabled: true })`,
		// so only the default row decides. An organization whose default was
		// saved without a credential is refused even when another enabled row
		// carries one — and reporting otherwise here would hide the notice
		// while every real call still fails, which is the divergence this
		// field exists to remove.
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([
			row({ isDefault: true, encryptedApiKey: null }),
			row({
				isDefault: false,
				provider: "ANTHROPIC",
				encryptedApiKey: "encrypted:sk-non-default",
			}),
		]);
		// No personal rows, so the last rung cannot rescue it either.
		mockDb.userCloudProviderConfig.findMany.mockResolvedValue([]);

		const result = await callInOrg();

		expect(result.canResolveProvider).toBe(false);
		// `isConfigured` still describes the TENANT and is unchanged: the
		// organization does have enabled providers. The two fields disagreeing
		// here is the point of having both.
		expect(result.isConfigured).toBe(true);
	});

	it("the default row's credential is what makes it resolvable", async () => {
		mockDb.cloudProviderConfig.findMany.mockResolvedValue([
			row({ isDefault: true, encryptedApiKey: "encrypted:sk-default" }),
			row({ isDefault: false, provider: "ANTHROPIC" }),
		]);

		expect((await callInOrg()).canResolveProvider).toBe(true);
	});
});
