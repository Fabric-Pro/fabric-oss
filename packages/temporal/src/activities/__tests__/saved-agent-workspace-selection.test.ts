import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ retrieve: vi.fn() }));
vi.mock("@repo/ai", () => ({ getCurrentDateContext: () => "Example date" }));
vi.mock("@repo/database", () => ({ db: {} }));
vi.mock("@repo/database/prisma/queries/workspaces/document-content", () => ({
	authorizeWorkspaceDocumentRead: vi.fn(),
}));
vi.mock("../direct-chat/rag-retrieval", () => ({
	retrieveWorkspaceDocumentsActivity: m.retrieve,
}));

import { buildAgentExecutionContext } from "../agent-execution-core/context-builder";
import { fetchKnowledgeSources } from "../agent-execution-core/knowledge-fetcher";
import { WorkspaceSelectionAccessError } from "../shared/workspace-document-access";

const selection = [
	{ workspaceId: "example-workspace", documentIds: ["example-document"] },
];
const template = {
	id: "example-template",
	name: "Example",
	displayName: "Example",
	description: "Example",
	instructions: "Example",
	knowledgeSources: [],
	tools: [],
	suggestedModel: null,
};
const instance = {
	id: "example-agent",
	name: "Example",
	description: null,
	customInstructions: { knowledgeFilters: selection },
	modelOverride: null,
	modelConfig: null,
};
const connections = {
	integrationConfigurations: [],
	toolConnections: {},
	workspaceIds: ["example-workspace"],
};
const input = {
	knowledgeSources: [],
	workspaceIds: connections.workspaceIds,
	workspaceDocumentFilters: selection,
	userId: "example-user",
	organizationId: "example-org",
	query: "Example question",
	executionId: "example-execution",
};

beforeEach(() => {
	vi.resetAllMocks();
	m.retrieve.mockResolvedValue({ context: "", chunkCount: 0 });
});
describe("saved workspace selections through agent context and knowledge", () => {
	it("reads the builder's persisted knowledgeFilters property", () => {
		expect(
			buildAgentExecutionContext(
				template,
				instance,
				connections,
				input.userId,
				input.organizationId,
			),
		).toMatchObject({
			workspaceIds: input.workspaceIds,
			workspaceDocumentFilters: selection,
		});
	});
	it("uses an explicit connection snapshot instead of later saved selection changes", () => {
		const snapshot = [
			{
				workspaceId: "example-workspace",
				documentIds: ["example-frozen-document"],
			},
		];
		expect(
			buildAgentExecutionContext(
				template,
				instance,
				{ ...connections, workspaceDocumentFilters: snapshot },
				input.userId,
				input.organizationId,
			).workspaceDocumentFilters,
		).toEqual(snapshot);
	});
	it("never sends a workspace query without the saved document boundary", async () => {
		await fetchKnowledgeSources(input);
		expect(m.retrieve).toHaveBeenCalledExactlyOnceWith(
			input.query,
			input.userId,
			input.organizationId,
			input.workspaceIds,
			undefined,
			10,
			0.3,
			{ workspaceDocumentFilters: selection },
		);
	});
	it("fails closed on source revocation rather than producing an agent response with missing context", async () => {
		m.retrieve.mockRejectedValue(new WorkspaceSelectionAccessError());
		await expect(fetchKnowledgeSources(input)).rejects.toBeInstanceOf(
			WorkspaceSelectionAccessError,
		);
	});
});
