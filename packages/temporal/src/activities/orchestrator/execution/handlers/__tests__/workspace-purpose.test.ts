import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	retrieve: vi.fn(async (..._args: unknown[]) => ({
		context: "example",
		chunkCount: 1,
	})),
}));
vi.mock("../../../../direct-chat/rag-retrieval", () => ({
	retrieveWorkspaceDocumentsActivity: h.retrieve,
}));

import { UnifiedSearchHandler } from "../unified-search-handler";
import { WorkspaceRagHandler } from "../workspace-rag-handler";

beforeEach(() => vi.clearAllMocks());
it.each([WorkspaceRagHandler, UnifiedSearchHandler])(
	"leaves the operation purpose to shared retrieval from %s",
	async (Handler) => {
		const handler = new Handler();
		await handler.execute({
			input: {
				userId: "example-user",
				organizationId: "example-org",
				workspaceIds: ["example-workspace"],
				step: {
					id: "example-step",
					app: "workspace_rag_query",
					inputs: { query: "example" },
				},
			},
			variables: {},
			toolCalls: [],
			startTime: Date.now(),
		} as any);
		expect(h.retrieve.mock.calls[0][7]).not.toHaveProperty("callPurpose");
	},
);
