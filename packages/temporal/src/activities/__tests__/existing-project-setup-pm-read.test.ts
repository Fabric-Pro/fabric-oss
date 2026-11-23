import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	fetch: vi.fn(),
	create: vi.fn(),
	findFirst: vi.fn(),
	embed: vi.fn(),
	resolveText: vi.fn(async () => ({})),
	warn: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: { projectContext: { create: h.create, findFirst: h.findFirst } },
	resolveModelWithCredentials: h.resolveText,
	tenantWhere: vi.fn(),
}));
const documentsProvider = {
	apiKey: "example-openai-key",
	provider: "OPENAI_DIRECT",
	baseUrl: null,
};
vi.mock("@repo/ai", () => ({
	resolveProviderApiKey: vi.fn(
		async (config: { federatedOrganizationId?: string }) => {
			if (config.federatedOrganizationId) {
				throw new Error(
					"Anthropic federation requires a Bearer credential",
				);
			}
			return "example-key";
		},
	),
	getSystemEmbeddingRAGProviderConfig: vi.fn(async () => documentsProvider),
}));
vi.mock("@repo/logs", () => ({ logger: { info: vi.fn(), warn: h.warn } }));
vi.mock("@repo/rag/lib/project-contexts/auto-embed", () => ({
	embedProjectContext: h.embed,
}));
vi.mock("../pm-integration/fetch-pm-hierarchy", () => ({
	fetchPMWorkItemsByType: h.fetch,
}));
vi.mock("../pm-integration/story-sync", () => ({
	discoverPMToolCapabilities: vi.fn(async () => ({ taskList: {} })),
}));

import { getSystemEmbeddingRAGProviderConfig } from "@repo/ai";
import {
	embedCodeAnalysisContext,
	ingestBacklogForRAG,
} from "../existing-project-setup";

const input = {
	projectId: "example-project",
	userId: "example-user",
	organizationId: "example-org",
	mcpConfigId: "example-config",
	containerId: "example-board",
};
beforeEach(() => {
	vi.clearAllMocks();
	h.create.mockResolvedValue({ id: "example-context" });
});
it("throws on a failed board read before creating or embedding a context", async () => {
	h.fetch.mockResolvedValue({
		epics: [],
		features: [],
		stories: [],
		readStatus: "failed",
	});
	await expect(ingestBacklogForRAG(input)).rejects.toThrow(
		"Could not read the PM board",
	);
	expect(h.create).not.toHaveBeenCalled();
});
it("keeps empty ingestion for no-columns and warns with the cause", async () => {
	h.fetch.mockResolvedValue({
		epics: [],
		features: [],
		stories: [],
		readStatus: "no-columns",
	});
	await ingestBacklogForRAG(input);
	expect(h.create).toHaveBeenCalledOnce();
	expect(h.warn).toHaveBeenCalledWith(
		expect.stringContaining("no workflow columns"),
		expect.anything(),
	);
});

it.each(["credentials", "other"])(
	"uses the correct retry policy for %s without saving context",
	async (readErrorKind) => {
		h.fetch.mockResolvedValue({
			epics: [],
			features: [],
			stories: [],
			readStatus: "failed",
			readErrorKind,
		});
		try {
			await ingestBacklogForRAG(input);
			throw new Error("Expected ingest rejection");
		} catch (error) {
			if (readErrorKind === "credentials") {
				expect(error).toMatchObject({
					nonRetryable: true,
					message:
						"Could not read the PM board. Reconnect it in Connections.",
				});
			} else {
				expect(error).toBeInstanceOf(Error);
				expect(error).not.toHaveProperty("nonRetryable", true);
			}
		}
		expect(h.create).not.toHaveBeenCalled();
	},
);

it("warns on a truncated listing and still ingests the available items", async () => {
	h.fetch.mockResolvedValue({
		epics: [],
		features: [],
		stories: [{ id: "42", title: "Example issue" }],
		readStatus: "ok",
		listingTruncated: true,
	});
	await ingestBacklogForRAG(input);
	expect(h.create).toHaveBeenCalledOnce();
	expect(h.warn).toHaveBeenCalledWith(
		"[ExistingProjectSetup] PM board listing was truncated",
		{ totalItems: 1 },
	);
});

describe.each(["API key", "federated credentials"])(
	"with Anthropic %s as the default",
	(authMode) => {
		beforeEach(() => {
			h.resolveText.mockResolvedValue({
				provider: "ANTHROPIC_DIRECT",
				...(authMode === "federated credentials" && {
					federatedOrganizationId: input.organizationId,
				}),
			});
			h.fetch.mockResolvedValue({
				epics: [],
				features: [],
				stories: [{ id: "42", title: "Example issue" }],
				readStatus: "ok",
			});
			h.findFirst.mockResolvedValue({ content: "Example analysis" });
		});

		function expectDocumentsProvider(provider: string) {
			expect(h.resolveText).not.toHaveBeenCalled();
			expect(getSystemEmbeddingRAGProviderConfig).toHaveBeenCalledWith({
				userId: input.userId,
				organizationId: input.organizationId,
			});
			expect(h.embed).toHaveBeenCalledWith(
				expect.objectContaining({
					contextId: "example-context",
					organizationId: input.organizationId,
					apiKey: documentsProvider,
					metadata: expect.objectContaining({ provider }),
				}),
			);
		}

		it("uses the documents provider for the backlog", async () => {
			await expect(ingestBacklogForRAG(input)).resolves.toEqual({
				contextId: "example-context",
				itemCounts: { epics: 0, features: 0, stories: 1 },
			});
			expectDocumentsProvider("BACKLOG_INGEST");
		});

		it("uses the documents provider for code analysis", async () => {
			await expect(
				embedCodeAnalysisContext({
					...input,
					contextId: "example-context",
				}),
			).resolves.toBeUndefined();
			expectDocumentsProvider("CODE_ANALYSIS");
		});
	},
);
