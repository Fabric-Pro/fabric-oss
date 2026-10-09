/**
 * Audit trail for AI provider credential configuration.
 *
 * Saving, replacing, re-pointing or deleting a provider config used to leave no
 * row, so an overwritten config could not be traced or recovered. Each mutation
 * now records who changed what. The recorded metadata is non-secret by
 * construction: these tests pin the action, the resource, the before/after
 * shape, the tenancy fields, and that neither the API key, the client secret,
 * nor their encrypted form (nor URL userinfo) reaches the audit call.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mockRecordAudit, tx, mockRequireOrgMembership } = vi.hoisted(
	() => {
		const model = () => ({
			findUnique: vi.fn(),
			findFirst: vi.fn(),
			update: vi.fn(),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			create: vi.fn(),
			deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
		});
		const tx = {
			cloudProviderConfig: model(),
			userCloudProviderConfig: model(),
			organizationModelPreference: model(),
			userModelPreference: model(),
		};
		const mockDb = {
			cloudProviderConfig: tx.cloudProviderConfig,
			userCloudProviderConfig: tx.userCloudProviderConfig,
			organizationModelPreference: tx.organizationModelPreference,
			userModelPreference: tx.userModelPreference,
			$transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
		};
		return {
			mockDb,
			tx,
			mockRecordAudit: vi.fn(),
			mockRequireOrgMembership: vi.fn(),
		};
	},
);

vi.mock("@repo/database", () => ({
	db: mockDb,
	LLM_PROVIDER_PURPOSE_FILTER: { purpose: { not: "EMBEDDINGS_ONLY" } },
	getProviderMetadata: vi.fn(() => ({
		requiresBaseUrl: false,
		displayName: "Test provider",
	})),
	getProviderDisplayName: vi.fn((p: string) => p),
	getEmbeddingProviderConfig: vi.fn().mockResolvedValue({ provider: null }),
	ALL_EMBEDDING_CAPABLE_PROVIDERS: [],
	canProviderSupportEmbeddings: vi.fn(() => true),
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: vi.fn((key: string) => `encrypted:${key}`),
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...args: unknown[]) => mockRecordAudit(...args),
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
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
		requirePermission: vi.fn(() => ({})),
		requireInputOrgPermission: vi.fn(() => ({})),
		Permissions: new Proxy(
			{},
			{ get: (_, prop: string) => prop.toLowerCase() },
		),
	};
});

import { snapshotProviderRow } from "../../../lib/provider-audit";
import {
	deleteUserProviderProcedure,
	setDefaultProviderProcedure,
	setEmbeddingProviderProcedure,
	updateEnabledProvidersProcedure,
	upsertUserProviderProcedure,
} from "../upsert";

type Handler = {
	_handler: (args: { input: unknown; context: unknown }) => Promise<unknown>;
};
const orgContext = {
	user: { id: "user-1", email: "admin@example.com" },
	session: { id: "s1", activeOrganizationId: "org-1" },
};
const personalContext = {
	user: { id: "user-1", email: "admin@example.com" },
	session: { id: "s1", activeOrganizationId: null },
};

// The procedure mock resolves the tenant from the input, so an input that does
// not name an organization takes the context's active one.
const call = (
	procedure: unknown,
	input: Record<string, unknown>,
	context: typeof orgContext | typeof personalContext,
) =>
	(procedure as Handler)._handler({
		input: {
			organizationId: context.session.activeOrganizationId,
			...input,
		},
		context,
	});

const API_KEY = "sk-live-super-secret-key";
const CLIENT_SECRET = "dbx-client-secret-value";

function auditCall() {
	expect(mockRecordAudit).toHaveBeenCalledTimes(1);
	const [, input] = mockRecordAudit.mock.calls[0] as [
		unknown,
		{
			action: string;
			category: string;
			organizationId?: string | null;
			resource: { type: string; id: string; name: string };
			metadata: Record<string, unknown>;
		},
	];
	return input;
}

function expectNoSecrets(input: unknown) {
	const serialized = JSON.stringify(input);
	for (const secret of [
		API_KEY,
		CLIENT_SECRET,
		`encrypted:${API_KEY}`,
		`encrypted:${CLIENT_SECRET}`,
		"userinfo-pass",
		"query-secret",
	]) {
		expect(serialized).not.toContain(secret);
	}
}

const existingRow = {
	id: "cpc_1",
	provider: "AZURE_AI_FOUNDRY",
	clientId: null,
	enabled: true,
	isDefault: false,
	isEmbeddingProvider: false,
	config: {
		baseUrl: "https://old-resource.openai.azure.com",
		deploymentName: "old-deployment",
	},
};

beforeEach(() => {
	vi.clearAllMocks();
	mockRequireOrgMembership.mockResolvedValue({ role: "admin" });
	for (const model of [tx.cloudProviderConfig, tx.userCloudProviderConfig]) {
		model.findUnique.mockResolvedValue(null);
		model.findFirst.mockResolvedValue(null);
	}
});

describe("snapshotProviderRow", () => {
	it("keeps only protocol, host and path of a base URL", () => {
		const snapshot = snapshotProviderRow({
			config: {
				baseUrl:
					"https://user:userinfo-pass@example.com/openai/v1?key=query-secret",
			},
		});

		expect(snapshot.baseUrl).toBe("https://example.com/openai/v1");
		expectNoSecrets(snapshot);
	});
});

describe("upsert audit", () => {
	it("records org.ai_provider.configured for a new org provider, without the key", async () => {
		tx.cloudProviderConfig.create.mockImplementation(
			async ({ data }: { data: Record<string, unknown> }) => ({
				...data,
				id: "cpc_new",
			}),
		);

		await call(
			upsertUserProviderProcedure,
			{
				provider: "AZURE_AI_FOUNDRY",
				apiKey: API_KEY,
				baseUrl:
					"https://example-resource.services.ai.azure.com/openai/v1?key=query-secret",
				deploymentName: "prod-chat",
				organizationId: "org-1",
			},
			orgContext,
		);

		const audit = auditCall();
		expect(audit.action).toBe("org.ai_provider.configured");
		expect(audit.category).toBe("org");
		expect(audit.organizationId).toBe("org-1");
		expect(audit.resource).toEqual({
			type: "ai_provider",
			id: "cpc_new",
			name: "AZURE_AI_FOUNDRY",
		});
		expect(audit.metadata).toMatchObject({
			provider: "AZURE_AI_FOUNDRY",
			keyChanged: true,
			before: null,
			after: {
				baseUrl:
					"https://example-resource.services.ai.azure.com/openai/v1",
				deploymentName: "prod-chat",
				hasClientId: false,
				isDefault: true,
				enabled: true,
			},
		});
		expect(audit.metadata.changedFields).toEqual(
			expect.arrayContaining(["baseUrl", "deploymentName", "isDefault"]),
		);
		expectNoSecrets(audit);
	});

	it("records org.ai_provider.updated with before/after when a config is overwritten", async () => {
		tx.cloudProviderConfig.findUnique.mockResolvedValue(existingRow);
		tx.cloudProviderConfig.update.mockImplementation(
			async ({ data }: { data: Record<string, unknown> }) => ({
				...existingRow,
				...data,
			}),
		);

		await call(
			upsertUserProviderProcedure,
			{
				provider: "AZURE_AI_FOUNDRY",
				apiKey: API_KEY,
				baseUrl: "https://new-resource.openai.azure.com",
				deploymentName: "old-deployment",
				organizationId: "org-1",
			},
			orgContext,
		);

		const audit = auditCall();
		expect(audit.action).toBe("org.ai_provider.updated");
		expect(audit.resource.id).toBe("cpc_1");
		expect(audit.metadata.before).toMatchObject({
			baseUrl: "https://old-resource.openai.azure.com/",
			deploymentName: "old-deployment",
		});
		expect(audit.metadata.after).toMatchObject({
			baseUrl: "https://new-resource.openai.azure.com/",
		});
		expect(audit.metadata.changedFields).toContain("baseUrl");
		expect(audit.metadata.changedFields).not.toContain("deploymentName");
		expectNoSecrets(audit);
	});

	it("records account.ai_provider.configured for a personal provider, with no organization", async () => {
		tx.userCloudProviderConfig.create.mockImplementation(
			async ({ data }: { data: Record<string, unknown> }) => ({
				...data,
				id: "ucpc_new",
			}),
		);

		await call(
			upsertUserProviderProcedure,
			{
				provider: "DATABRICKS",
				clientId: "sp-client-id",
				clientSecret: CLIENT_SECRET,
				baseUrl: "https://example.cloud.databricks.com",
				organizationId: null,
			},
			personalContext,
		);

		const audit = auditCall();
		expect(audit.action).toBe("account.ai_provider.configured");
		expect(audit.category).toBe("account");
		expect(audit.organizationId).toBeNull();
		expect(audit.resource).toMatchObject({
			type: "ai_provider",
			id: "ucpc_new",
			name: "DATABRICKS",
		});
		expect(audit.metadata).toMatchObject({
			keyChanged: true,
			after: { hasClientId: true },
		});
		expectNoSecrets(audit);
	});

	it("records account.ai_provider.updated when a personal config is overwritten", async () => {
		tx.userCloudProviderConfig.findUnique.mockResolvedValue({
			...existingRow,
			id: "ucpc_1",
		});
		tx.userCloudProviderConfig.update.mockImplementation(
			async ({ data }: { data: Record<string, unknown> }) => ({
				...existingRow,
				id: "ucpc_1",
				...data,
			}),
		);

		await call(
			upsertUserProviderProcedure,
			{
				provider: "AZURE_AI_FOUNDRY",
				apiKey: API_KEY,
				baseUrl: "https://old-resource.openai.azure.com",
				deploymentName: "renamed",
				organizationId: null,
			},
			personalContext,
		);

		const audit = auditCall();
		expect(audit.action).toBe("account.ai_provider.updated");
		expect(audit.metadata.changedFields).toContain("deploymentName");
		expectNoSecrets(audit);
	});
});

describe("setDefault audit", () => {
	it.each([
		[
			"org",
			"org.ai_provider.default_changed",
			orgContext,
			"cloudProviderConfig",
		],
		[
			"personal",
			"account.ai_provider.default_changed",
			personalContext,
			"userCloudProviderConfig",
		],
	] as const)(
		"records the %s default change with the previous default",
		async (_l, action, context, model) => {
			tx[model].findFirst
				.mockResolvedValueOnce({
					id: "old_1",
					provider: "OPENAI_DIRECT",
				})
				.mockResolvedValueOnce({
					...existingRow,
					provider: "AZURE_AI_FOUNDRY",
				});

			await call(
				setDefaultProviderProcedure,
				{ provider: "AZURE_AI_FOUNDRY" },
				context,
			);

			const audit = auditCall();
			expect(audit.action).toBe(action);
			expect(audit.resource).toEqual({
				type: "ai_provider",
				id: "cpc_1",
				name: "AZURE_AI_FOUNDRY",
			});
			expect(audit.metadata).toMatchObject({
				provider: "AZURE_AI_FOUNDRY",
				before: { isDefault: false },
				after: { isDefault: true },
				previousDefaultProvider: "OPENAI_DIRECT",
			});
			expectNoSecrets(audit);
		},
	);
});

describe("setEmbedding audit", () => {
	it.each([
		[
			"org",
			"org.ai_provider.embedding_changed",
			orgContext,
			"cloudProviderConfig",
		],
		[
			"personal",
			"account.ai_provider.embedding_changed",
			personalContext,
			"userCloudProviderConfig",
		],
	] as const)(
		"records the %s embedding change with the previous provider",
		async (_l, action, context, model) => {
			tx[model].findFirst
				.mockResolvedValueOnce({
					id: "old_1",
					provider: "OPENAI_DIRECT",
				})
				.mockResolvedValueOnce(existingRow);

			await call(
				setEmbeddingProviderProcedure,
				{ provider: "AZURE_AI_FOUNDRY" },
				context,
			);

			const audit = auditCall();
			expect(audit.action).toBe(action);
			expect(audit.metadata).toMatchObject({
				provider: "AZURE_AI_FOUNDRY",
				before: { isEmbeddingProvider: false },
				after: { isEmbeddingProvider: true },
				previousEmbeddingProvider: "OPENAI_DIRECT",
			});
			expectNoSecrets(audit);
		},
	);
});

describe("updateEnabledProviders audit", () => {
	it.each([
		[
			"org",
			"org.ai_provider.enabled_providers_changed",
			orgContext,
			"cloudProviderConfig",
		],
		[
			"personal",
			"account.ai_provider.enabled_providers_changed",
			personalContext,
			"userCloudProviderConfig",
		],
	] as const)(
		"records the %s enabled-provider list before and after",
		async (_l, action, context, model) => {
			tx[model].findUnique.mockResolvedValue({
				...existingRow,
				config: { enabledProviders: ["openai"] },
			});

			await call(
				updateEnabledProvidersProcedure,
				{
					provider: "VERCEL_GATEWAY",
					enabledProviders: ["openai", "anthropic"],
				},
				context,
			);

			const audit = auditCall();
			expect(audit.action).toBe(action);
			expect(audit.metadata).toMatchObject({
				before: { enabledProviders: ["openai"] },
				after: { enabledProviders: ["openai", "anthropic"] },
			});
			expectNoSecrets(audit);
		},
	);
});

describe("delete audit", () => {
	it.each([
		["org", "org.ai_provider.deleted", orgContext, "cloudProviderConfig"],
		[
			"personal",
			"account.ai_provider.deleted",
			personalContext,
			"userCloudProviderConfig",
		],
	] as const)(
		"records the %s deletion with what the row held",
		async (_l, action, context, model) => {
			tx[model].findFirst
				.mockResolvedValueOnce(existingRow)
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce({
					id: "next_1",
					provider: "OPENAI_DIRECT",
				});

			await call(
				deleteUserProviderProcedure,
				{ provider: "AZURE_AI_FOUNDRY" },
				context,
			);

			const audit = auditCall();
			expect(audit.action).toBe(action);
			expect(audit.resource).toEqual({
				type: "ai_provider",
				id: "cpc_1",
				name: "AZURE_AI_FOUNDRY",
			});
			expect(audit.metadata).toMatchObject({
				provider: "AZURE_AI_FOUNDRY",
				before: { deploymentName: "old-deployment" },
				defaultReassignedTo: "OPENAI_DIRECT",
			});
			expectNoSecrets(audit);
		},
	);

	it("records nothing when there was no config to delete", async () => {
		await call(
			deleteUserProviderProcedure,
			{ provider: "AZURE_AI_FOUNDRY" },
			personalContext,
		);

		expect(mockRecordAudit).not.toHaveBeenCalled();
	});
});
