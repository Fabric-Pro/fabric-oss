import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAiConfigStatusProcedure } from "../get-status";

type Resolution = {
	provider: string | null;
	source: "organization" | "user" | null;
};
type ProviderRow = {
	provider: "OPENAI_DIRECT";
	displayName: string;
	isDefault: boolean;
	isEmbeddingProvider: boolean;
	purpose: "ALL";
	useWhenPlanSpent: boolean;
	encryptedApiKey: string;
};
type OrganizationEmbedding = {
	provider: null;
	model: null;
	identity: null;
	source: null;
};

const mocks = vi.hoisted(() => ({
	organizationEmbedding: vi.fn<() => Promise<OrganizationEmbedding>>(),
	organizationProviders: vi.fn<() => Promise<ProviderRow[]>>(),
	organizationDefault: vi.fn<() => Promise<"OPENAI_DIRECT" | null>>(),
	personalProviders: vi.fn<() => Promise<ProviderRow[]>>(),
	tenant: vi.fn<() => Promise<Resolution>>(),
	embedding: vi.fn<() => Promise<Resolution>>(),
	planSpent: vi.fn<() => Promise<{ provider: string } | null>>(),
	membership: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		cloudProviderConfig: { findMany: mocks.organizationProviders },
		userCloudProviderConfig: { findMany: mocks.personalProviders },
	},
	getOrganizationDefaultProvider: mocks.organizationDefault,
	getAiProviderApiKey: mocks.tenant,
	getEmbeddingProviderConfig: mocks.embedding,
	getPlanSpentPersonalProviderConfig: mocks.planSpent,
	getModelForTask: vi.fn(async () => null),
	getProviderDisplayName: (provider: string) => provider,
	isGatewayProvider: () => false,
	LLM_PROVIDER_PURPOSE_FILTER: { purpose: { not: "EMBEDDINGS_ONLY" } },
	readProviderRowCredentials: (row: ProviderRow) => ({
		hasCredentials: Boolean(row.encryptedApiKey),
	}),
	getOrganizationMembership: mocks.membership,
	getTenantContext: () => ({ effectiveWriteOrgId: null }),
	grantProjectAccess: vi.fn(),
}));

vi.mock("../../../lib/organization-embedding-resolution", async () => {
	const { z } = await import("zod");
	return {
		resolveOrganizationEmbedding: mocks.organizationEmbedding,
		organizationEmbeddingSchema: z.object({
			provider: z.null(),
			model: z.null(),
			identity: z.null(),
			source: z.null(),
		}),
	};
});

vi.mock("../../../../../orpc/procedures", async () => {
	const { os } = await import("@orpc/server");
	const { Permissions } = await import("@repo/permissions");
	const { requireInputOrgPermission } = await import(
		"../../../../../orpc/middleware/require-permission"
	);
	return {
		tenantProtectedProcedure: os.$context<{
			headers: Headers;
			user: { id: string };
			session: { activeOrganizationId: string };
			activeOrganizationRole: string | null;
			allowedProjectIds: string[];
		}>(),
		Permissions,
		requireInputOrgPermission,
		resolveOrganizationId: (
			organizationId: string | null | undefined,
			session: { activeOrganizationId: string },
		) =>
			organizationId === undefined
				? session.activeOrganizationId
				: organizationId,
	};
});

const context = {
	headers: new Headers(),
	user: { id: "example-user" },
	session: { activeOrganizationId: "example-session-org" },
	activeOrganizationRole: "owner",
	allowedProjectIds: [],
};
const emptyEmbedding: OrganizationEmbedding = {
	provider: null,
	model: null,
	identity: null,
	source: null,
};
const emptyResolution: Resolution = { provider: null, source: null };
const configuredRow: ProviderRow = {
	provider: "OPENAI_DIRECT",
	displayName: "Example provider",
	isDefault: true,
	isEmbeddingProvider: false,
	purpose: "ALL",
	useWhenPlanSpent: false,
	encryptedApiKey: "encrypted-example-key",
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function getStatus(organizationId: string | null = "example-org") {
	return call(getAiConfigStatusProcedure, { organizationId }, { context });
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.membership.mockResolvedValue({ role: "owner" });
	mocks.organizationEmbedding.mockResolvedValue(emptyEmbedding);
	mocks.organizationProviders.mockResolvedValue([configuredRow]);
	mocks.organizationDefault.mockResolvedValue("OPENAI_DIRECT");
	mocks.personalProviders.mockResolvedValue([]);
	mocks.tenant.mockResolvedValue(emptyResolution);
	mocks.embedding.mockResolvedValue(emptyResolution);
	mocks.planSpent.mockResolvedValue(null);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("AI status read concurrency", () => {
	it("overlaps independent reads and waits for the tenant before resolving embedding", async () => {
		const organizationEmbedding = deferred<OrganizationEmbedding>();
		const providers = deferred<ProviderRow[]>();
		const defaultProvider = deferred<"OPENAI_DIRECT" | null>();
		const tenant = deferred<Resolution>();
		const embedding = deferred<Resolution>();
		const planSpent = deferred<{ provider: string } | null>();
		mocks.organizationEmbedding.mockReturnValue(
			organizationEmbedding.promise,
		);
		mocks.organizationProviders.mockReturnValue(providers.promise);
		mocks.organizationDefault.mockReturnValue(defaultProvider.promise);
		mocks.tenant.mockReturnValue(tenant.promise);
		mocks.embedding.mockReturnValue(embedding.promise);
		mocks.planSpent.mockReturnValue(planSpent.promise);

		const result = getStatus();
		await vi.waitFor(() => {
			for (const read of [
				mocks.organizationEmbedding,
				mocks.organizationProviders,
				mocks.organizationDefault,
				mocks.tenant,
				mocks.planSpent,
			]) {
				expect(read).toHaveBeenCalledOnce();
			}
		});
		expect(mocks.embedding).not.toHaveBeenCalled();
		tenant.resolve({ provider: "ANTHROPIC", source: "user" });
		await vi.waitFor(() => expect(mocks.embedding).toHaveBeenCalledOnce());
		expect(mocks.tenant).toHaveBeenCalledWith({
			userId: "example-user",
			organizationId: "example-org",
		});
		expect(mocks.organizationProviders).toHaveBeenCalledWith({
			where: { organizationId: "example-org", enabled: true },
			orderBy: [{ isDefault: "desc" }, { priority: "desc" }],
		});
		expect(mocks.organizationDefault).toHaveBeenCalledWith("example-org");

		organizationEmbedding.resolve(emptyEmbedding);
		providers.resolve([configuredRow]);
		defaultProvider.resolve("OPENAI_DIRECT");
		embedding.resolve(emptyResolution);
		planSpent.resolve({ provider: "ANTHROPIC" });
		await expect(result).resolves.toMatchObject({
			isConfigured: true,
			canResolveProvider: true,
			hasOrgConfig: true,
			hasUserConfig: false,
			defaultProvider: "OPENAI_DIRECT",
			resolvedProvider: "ANTHROPIC",
			resolvedProviderSource: "user",
			resolvedEmbeddingProvider: "ANTHROPIC",
			resolvedEmbeddingSource: "user",
			planSpentPersonalProvider: "ANTHROPIC",
			configuredProviders: [
				{ provider: "OPENAI_DIRECT", source: "org_config" },
			],
		});
		expect(mocks.personalProviders).not.toHaveBeenCalled();
	});

	it("keeps personal reads exclusive when the explicit context is null", async () => {
		const providers = deferred<ProviderRow[]>();
		const tenant = deferred<Resolution>();
		mocks.personalProviders.mockReturnValue(providers.promise);
		mocks.tenant.mockReturnValue(tenant.promise);
		const result = getStatus(null);
		await vi.waitFor(() => {
			expect(mocks.personalProviders).toHaveBeenCalledOnce();
			expect(mocks.tenant).toHaveBeenCalledOnce();
			expect(mocks.planSpent).toHaveBeenCalledOnce();
		});
		expect(mocks.organizationEmbedding).not.toHaveBeenCalled();
		expect(mocks.organizationProviders).not.toHaveBeenCalled();
		expect(mocks.organizationDefault).not.toHaveBeenCalled();
		expect(mocks.personalProviders).toHaveBeenCalledWith({
			where: { userId: "example-user", enabled: true },
			orderBy: [{ isDefault: "desc" }, { priority: "desc" }],
		});
		providers.resolve([{ ...configuredRow, useWhenPlanSpent: true }]);
		tenant.resolve({ provider: "OPENAI_DIRECT", source: "user" });
		await expect(result).resolves.toMatchObject({
			hasUserConfig: true,
			hasOrgConfig: false,
			canResolveProvider: true,
			organizationEmbedding: null,
			resolvedProviderSource: "user",
			configuredProviders: [
				{ source: "user_config", useWhenPlanSpent: true },
			],
		});
	});

	it("handles optional failures while the required provider query is pending", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const providers = deferred<ProviderRow[]>();
		mocks.organizationProviders.mockReturnValue(providers.promise);
		for (const read of [
			mocks.organizationEmbedding,
			mocks.tenant,
			mocks.embedding,
			mocks.planSpent,
		]) {
			read.mockRejectedValue(new Error("example optional read failed"));
		}
		const result = getStatus();
		await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(4));
		providers.resolve([configuredRow]);
		await expect(result).resolves.toMatchObject({
			isConfigured: true,
			defaultProvider: "OPENAI_DIRECT",
			organizationEmbedding: null,
			resolvedProvider: null,
			resolvedEmbeddingProvider: null,
			planSpentPersonalProvider: null,
		});
	});

	it.each(["organizationProviders", "organizationDefault"] as const)(
		"preserves a fatal %s failure and handles later optional rejections",
		async (requiredRead) => {
			const errors = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			const organizationEmbedding = deferred<OrganizationEmbedding>();
			const tenant = deferred<Resolution>();
			const planSpent = deferred<{ provider: string } | null>();
			mocks.organizationEmbedding.mockReturnValue(
				organizationEmbedding.promise,
			);
			mocks.tenant.mockReturnValue(tenant.promise);
			mocks.planSpent.mockReturnValue(planSpent.promise);
			const failure = new Error("example required read failed");
			mocks[requiredRead].mockRejectedValue(failure);
			await expect(getStatus()).rejects.toThrow(failure);
			organizationEmbedding.reject(
				new Error("example late embedding failure"),
			);
			tenant.reject(new Error("example late tenant failure"));
			planSpent.reject(
				new Error("example late personal fallback failure"),
			);
			await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(3));
		},
	);

	it("refuses a foreign organization before starting any status read", async () => {
		mocks.membership.mockResolvedValue(null);
		await expect(getStatus("example-foreign-org")).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.membership).toHaveBeenCalledWith(
			"example-foreign-org",
			"example-user",
		);
		for (const read of [
			mocks.organizationEmbedding,
			mocks.organizationProviders,
			mocks.organizationDefault,
			mocks.personalProviders,
			mocks.tenant,
			mocks.embedding,
			mocks.planSpent,
		]) {
			expect(read).not.toHaveBeenCalled();
		}
	});
});
