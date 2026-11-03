import { expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	hasProjectAccess: vi.fn(async () => true),
	db: {
		projectWeaveConfig: { findUnique: vi.fn(async () => null) },
		project: { findUnique: vi.fn(async () => null) },
	},
}));
vi.mock("@repo/rag", async () => ({
	...(await import("@repo/rag/lib/project-contexts/source-name")),
	contextMetaHeader: () => "",
	retrieveProjectContexts: vi.fn(async () => [
		{
			content: "named body",
			sourceTitle: "Launch plan",
			metadata: { filename: "wrong" },
		},
		{ content: "unnamed body" },
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
	expect(result).toContain("### Launch plan");
	expect(result).toContain("### Context 2");
	expect(result).not.toContain("### wrong");
});
