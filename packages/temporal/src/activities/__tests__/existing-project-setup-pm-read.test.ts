import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	fetch: vi.fn(),
	create: vi.fn(),
	warn: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: { projectContext: { create: h.create } },
	resolveModelWithCredentials: vi.fn(async () => ({})),
	tenantWhere: vi.fn(),
}));
vi.mock("@repo/ai", () => ({
	resolveProviderApiKey: vi.fn(async () => "example-key"),
}));
vi.mock("@repo/logs", () => ({ logger: { info: vi.fn(), warn: h.warn } }));
vi.mock("@repo/rag/lib/project-contexts/auto-embed", () => ({
	embedProjectContext: vi.fn(),
}));
vi.mock("../pm-integration/fetch-pm-hierarchy", () => ({
	fetchPMWorkItemsByType: h.fetch,
}));
vi.mock("../pm-integration/story-sync", () => ({
	discoverPMToolCapabilities: vi.fn(async () => ({ taskList: {} })),
}));

import { ingestBacklogForRAG } from "../existing-project-setup";

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
