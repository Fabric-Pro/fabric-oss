import { retrieveProjectContexts } from "@repo/rag";
import { expect, it, vi } from "vitest";

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	setAiUsageRecorder: vi.fn(),
	hasProjectAccess: vi.fn(async () => true),
	db: {
		projectWeaveConfig: { findUnique: vi.fn(async () => null) },
		project: { findUnique: vi.fn(async () => null) },
	},
}));
vi.mock("@repo/rag", async () => ({
	...(await import("@repo/rag/lib/project-contexts/retrieval")),
	contextMetaHeader: () => "",
	retrieveProjectContexts: vi.fn(async () => [
		{
			id: "example-source",
			type: "TEXT",
			score: 1,
			content: "WHOLE_BODY".repeat(10000),
			matchedPassages: [
				{ content: "MATCHED_PASSAGE", score: 1 },
				{ content: "x".repeat(30000), score: 0.5 },
			],
			sourceTitle: "Launch plan",
			metadata: { filename: "wrong" },
		},
		{ id: "example-two", type: "TEXT", score: 1, content: "unnamed body" },
	]),
}));

import { enrichWeaveDelegationMessage } from "../enrich-delegation";

it("names top-level sources and keeps the unnamed fallback", async () => {
	const result = await enrichWeaveDelegationMessage({
		agentId: "weave_thread",
		message: "plan",
		projectId: "example-project",
		userId: "example-user",
		organizationId: "example-org",
	});
	expect(retrieveProjectContexts).toHaveBeenCalledWith(
		expect.objectContaining({ includeMatchedPassages: true }),
	);
	expect(result).not.toContain("WHOLE_BODY");
	expect(result).toContain("MATCHED_PASSAGE");
	expect(
		result.match(/<project_context>[\s\S]*?<\/project_context>/)?.[0]
			.length,
	).toBeLessThanOrEqual(20000);
	expect(result).toContain("### From: Launch plan");
	expect(result).toContain("### From: Context 2");
	expect(result).not.toContain("### wrong");
});
