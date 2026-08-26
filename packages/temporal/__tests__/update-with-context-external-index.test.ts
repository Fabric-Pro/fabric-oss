/**
 * EXTERNAL_INDEX (project Databricks knowledge) labeling in the
 * "Update using context" source assembly.
 *
 * The load-bearing assertions: an external Databricks hit must NOT fall
 * through to the generic "DOC" / "Project Document" labels — the spec-editor
 * system prompt ranks internal Fabric artifacts above other sources, so
 * mislabeling external customer-corpus text as an internal document would
 * promote it to the highest precedence tier. And it must be explicitly
 * undated, never silently blank, so the model can't treat it as current.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	retrieveRelevantContextsForSpec: vi.fn(),
	fetchLiveIntegrationContext: vi.fn(),
}));

vi.mock("@repo/rag", () => ({
	EXTERNAL_INDEX_CONTEXT_TYPE: "EXTERNAL_INDEX",
	retrieveRelevantContextsForSpec: mocks.retrieveRelevantContextsForSpec,
}));
vi.mock("@repo/rag/lib/project-contexts/live-integration-context", () => ({
	fetchLiveIntegrationContext: mocks.fetchLiveIntegrationContext,
}));

const { fetchProjectContextSources, UPDATE_WITH_CONTEXT_SYSTEM_PROMPT } =
	await import("../src/lib/update-with-context-core");

const BASE = {
	projectId: "proj_1",
	userId: "user_1",
	baselineDate: new Date("2026-06-01T00:00:00Z"),
	specMarkdown: "# Spec",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.fetchLiveIntegrationContext.mockResolvedValue({
		teamsMessages: [],
		slackMessages: [],
		teamsMessageCount: 0,
		slackMessageCount: 0,
		hasTeams: false,
		hasSlack: false,
	});
});

describe("fetchProjectContextSources — EXTERNAL_INDEX attribution", () => {
	it("labels a Databricks hit as EXTERNAL_INDEX with its index title and an explicit undated marker", async () => {
		mocks.retrieveRelevantContextsForSpec.mockResolvedValue([
			{
				id: "databricks:int_1:cat.schema.idx_a:7",
				type: "EXTERNAL_INDEX",
				content: "external corpus text",
				score: 0.02,
				sourceTitle: "Databricks: cat.schema.idx_a",
				metadata: {
					isExternalIndex: true,
					integrationId: "int_1",
					indexName: "cat.schema.idx_a",
					externalId: "7",
				},
			},
		]);

		const sources = await fetchProjectContextSources(BASE);

		expect(sources.contextItems).toHaveLength(1);
		const item = sources.contextItems[0];
		expect(item.sourceType).toBe("EXTERNAL_INDEX");
		expect(item.sourceLabel).toBe("Databricks: cat.schema.idx_a");
		expect(item.sourceDate).toBe("undated (external index)");
		expect(item.sourceLinkOrId).toBe("databricks:int_1:cat.schema.idx_a:7");
	});

	it("still labels internal documents as before (no regression)", async () => {
		mocks.retrieveRelevantContextsForSpec.mockResolvedValue([
			{
				id: "ctx_1",
				type: "DOCUMENT_PRD",
				content: "internal doc",
				score: 0.03,
				sourceTitle: "PRD v2",
				metadata: {},
			},
		]);

		const sources = await fetchProjectContextSources(BASE);

		expect(sources.contextItems[0].sourceType).toBe("DOC");
		expect(sources.contextItems[0].sourceLabel).toBe("PRD v2");
		expect(sources.contextItems[0].sourceDate).toBe("");
	});
});

describe("system prompt — external-source precedence", () => {
	it("ranks EXTERNAL_INDEX below every internal artifact tier and warns about undated externals", () => {
		expect(UPDATE_WITH_CONTEXT_SYSTEM_PROMPT).toContain(
			"External indexed knowledge (source_type EXTERNAL_INDEX)",
		);
		expect(UPDATE_WITH_CONTEXT_SYSTEM_PROMPT).toContain(
			"undated (external index)",
		);
		// The external tier must come after the chat tier in the precedence
		// list (lowest priority).
		const chatTier = UPDATE_WITH_CONTEXT_SYSTEM_PROMPT.indexOf(
			"4) Team chats/messages",
		);
		const externalTier = UPDATE_WITH_CONTEXT_SYSTEM_PROMPT.indexOf(
			"5) External indexed knowledge",
		);
		expect(chatTier).toBeGreaterThan(-1);
		expect(externalTier).toBeGreaterThan(chatTier);
	});
});
