/**
 * The embedding model identity company context is written and searched with
 * (Fizzy #2719).
 *
 * It comes from the same resolver the embedding calls use, but as metadata
 * only: no model instance, no key decryption, no usage allowance consumed. A
 * model whose vectors do not fit the collections' fixed size is reported
 * unsupported, so ingestion refuses it and retrieval skips it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveModelWithProviderMock, getAIEmbeddingModelWithMetadataMock } =
	vi.hoisted(() => ({
		resolveModelWithProviderMock: vi.fn(),
		getAIEmbeddingModelWithMetadataMock: vi.fn(),
	}));

vi.mock("@repo/ai", () => {
	class AIProviderNotConfiguredError extends Error {
		constructor(message: string) {
			super(message);
			this.name = "AIProviderNotConfiguredError";
		}
	}
	return {
		AIProviderNotConfiguredError,
		hasProviderCredentials: (config: {
			apiKey?: string | null;
			clientId?: string | null;
			encryptedClientSecret?: string | null;
		}) =>
			Boolean(config.apiKey) ||
			Boolean(config.clientId && config.encryptedClientSecret),
		resolveModelWithProvider: resolveModelWithProviderMock,
		// Creates a model and passes the usage gate; must never be reached.
		getAIEmbeddingModelWithMetadata: getAIEmbeddingModelWithMetadataMock,
		logEmbeddingUsageAsync: vi.fn(),
	};
});

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	COMPANY_EMBEDDING_RESOLUTION,
	companyEmbeddingIdentity,
	resolveCompanyEmbeddingModel,
	UNSUPPORTED_EMBEDDING_MODEL_REASON,
	unsupportedEmbeddingModelMessage,
} from "../model";

function resolved(overrides: Record<string, unknown> = {}) {
	return {
		modelString: "text-embedding-3-small",
		provider: "OPENAI_DIRECT",
		apiKey: "encrypted-key",
		clientId: null,
		encryptedClientSecret: null,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	resolveModelWithProviderMock.mockResolvedValue(resolved());
});

describe("resolveCompanyEmbeddingModel", () => {
	it("names the organization's embedding model as provider and model string, from metadata only", async () => {
		const model = await resolveCompanyEmbeddingModel({
			organizationId: "org-1",
			userId: "user-1",
		});

		expect(model).toEqual({
			identity: "OPENAI_DIRECT:text-embedding-3-small",
			dimensions: 1536,
			supported: true,
		});
		expect(resolveModelWithProviderMock).toHaveBeenCalledWith("EMBEDDING", {
			userId: "user-1",
			organizationId: "org-1",
			organizationOnly: true,
		});
		expect(getAIEmbeddingModelWithMetadataMock).not.toHaveBeenCalled();
	});

	it("resolves one identity for two members with different personal embedding providers", async () => {
		// The resolver as it behaves for an organization with no provider of
		// its own: the acting member's personal provider decides, unless the
		// resolution is organization-only.
		const personal: Record<string, Record<string, unknown>> = {
			"user-admin": { provider: "OPENAI_DIRECT" },
			"user-member": {
				provider: "MISTRAL",
				modelString: "mistral-embed",
			},
		};
		resolveModelWithProviderMock.mockImplementation(
			async (
				_task: string,
				context: { userId: string; organizationOnly?: boolean },
			) =>
				context.organizationOnly
					? resolved({
							provider: "VERCEL_GATEWAY",
							modelString: "openai/text-embedding-3-small",
						})
					: resolved(personal[context.userId]),
		);

		const [admin, member] = await Promise.all(
			["user-admin", "user-member"].map((userId) =>
				resolveCompanyEmbeddingModel({
					organizationId: "org-1",
					userId,
				}),
			),
		);

		expect(admin.identity).toBe(
			"VERCEL_GATEWAY:openai/text-embedding-3-small",
		);
		expect(member).toEqual(admin);
	});

	it("names the flag every company embedding call passes", () => {
		expect(COMPANY_EMBEDDING_RESOLUTION).toEqual({
			organizationOnly: true,
		});
	});

	it("reads a gateway model's dimensions through its provider prefix", async () => {
		resolveModelWithProviderMock.mockResolvedValue(
			resolved({
				provider: "VERCEL_GATEWAY",
				modelString: "openai/text-embedding-3-small",
			}),
		);

		await expect(
			resolveCompanyEmbeddingModel({
				organizationId: "org-1",
				userId: "user-1",
			}),
		).resolves.toEqual({
			identity: "VERCEL_GATEWAY:openai/text-embedding-3-small",
			dimensions: 1536,
			supported: true,
		});
	});

	it("reports a model whose vectors do not fit the collection as unsupported", async () => {
		resolveModelWithProviderMock.mockResolvedValue(
			resolved({ modelString: "text-embedding-3-large" }),
		);

		const model = await resolveCompanyEmbeddingModel({
			organizationId: "org-1",
			userId: "user-1",
		});

		expect(model).toEqual({
			identity: "OPENAI_DIRECT:text-embedding-3-large",
			dimensions: 3072,
			supported: false,
		});
		const message = unsupportedEmbeddingModelMessage(model);
		expect(message.startsWith(UNSUPPORTED_EMBEDDING_MODEL_REASON)).toBe(
			true,
		);
		expect(message).toContain("OPENAI_DIRECT:text-embedding-3-large");
		expect(message).toContain("3072");
		expect(message).toContain("1536");
	});

	it("throws AIProviderNotConfiguredError when no embedding provider resolves", async () => {
		resolveModelWithProviderMock.mockResolvedValue(
			resolved({
				modelString: "",
				apiKey: null,
				_error: "No embedding provider configured.",
			}),
		);

		await expect(
			resolveCompanyEmbeddingModel({
				organizationId: "org-1",
				userId: "user-1",
			}),
		).rejects.toMatchObject({
			name: "AIProviderNotConfiguredError",
			message: "No embedding provider configured.",
		});
	});

	it("throws AIProviderNotConfiguredError for a model without credentials", async () => {
		resolveModelWithProviderMock.mockResolvedValue(
			resolved({ apiKey: null }),
		);

		await expect(
			resolveCompanyEmbeddingModel({
				organizationId: "org-1",
				userId: "user-1",
			}),
		).rejects.toMatchObject({ name: "AIProviderNotConfiguredError" });
	});

	it("refuses to resolve without an organization", async () => {
		await expect(
			resolveCompanyEmbeddingModel({
				organizationId: "",
				userId: "user-1",
			}),
		).rejects.toThrow(/requires an organizationId/);
		expect(resolveModelWithProviderMock).not.toHaveBeenCalled();
	});
});

describe("companyEmbeddingIdentity", () => {
	it("names a model the way the resolver does, so an embed's report and a readiness check compare equal", async () => {
		const model = await resolveCompanyEmbeddingModel({
			organizationId: "org-1",
			userId: "user-1",
		});

		expect(
			companyEmbeddingIdentity({
				provider: "OPENAI_DIRECT",
				modelString: "text-embedding-3-small",
			}),
		).toBe(model.identity);
	});

	it("refuses a model without its provider or model string", () => {
		expect(() =>
			companyEmbeddingIdentity({ provider: "", modelString: "m" }),
		).toThrow(/provider and model string/);
		expect(() =>
			companyEmbeddingIdentity({
				provider: "OPENAI_DIRECT",
				modelString: "",
			}),
		).toThrow(/provider and model string/);
	});
});
