/**
 * `createDocumentAssistantConversation`'s `proposedId`: the assistant's
 * CopilotKit thread id, offered as the new conversation's id so the thread
 * and the conversation share one id.
 *
 * The proposal is a request, never a claim. An id an `AgentConversation`
 * already has — another user's, another organization's, or the caller's own —
 * is ignored and the database generates one, so a proposal can never attach
 * a document assistant to a conversation that exists. The real-Postgres suite
 * (`__tests__/document-assistant-conversation.test.ts`) covers the transaction
 * itself; this one pins the id decision without a database.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique, createConversation, createJoin } = vi.hoisted(() => ({
	findUnique: vi.fn(),
	createConversation: vi.fn(),
	createJoin: vi.fn(),
}));

vi.mock("../../client", () => {
	const tx = {
		agentConversation: { findUnique, create: createConversation },
		documentAssistantConversation: { create: createJoin },
	};
	return {
		db: {
			$transaction: async (fn: (client: typeof tx) => Promise<unknown>) =>
				fn(tx),
		},
	};
});

import { createDocumentAssistantConversation } from "../document-assistant-conversation";

const THREAD_ID = "3f0c9a52-7d1e-4b8a-9c11-0d5e2f6a8b47";

function create(proposedId?: string) {
	return createDocumentAssistantConversation({
		tenantFilter: {
			organizationId: "org-example-1",
			userId: "user-example-1",
		},
		documentRefKind: "PROJECT_DOCUMENT",
		documentRefId: "doc-example-1",
		projectId: "project-example-1",
		agentId: "project_document_generator",
		...(proposedId ? { proposedId } : {}),
	});
}

function createdWith(): Record<string, unknown> {
	const [args] = createConversation.mock.calls[0] as [
		{ data: Record<string, unknown> },
	];
	return args.data;
}

beforeEach(() => {
	vi.clearAllMocks();
	createConversation.mockImplementation(
		async ({ data }: { data: { id?: string } }) => ({
			id: data.id ?? "cuid-generated",
		}),
	);
	createJoin.mockImplementation(
		async ({ data }: { data: { conversationId: string } }) => ({
			id: "join-example-1",
			conversationId: data.conversationId,
		}),
	);
});

describe("createDocumentAssistantConversation — proposedId", () => {
	it("creates the conversation under a free proposed id", async () => {
		findUnique.mockResolvedValue(null);

		const { conversation, join } = await create(THREAD_ID);

		expect(findUnique).toHaveBeenCalledWith({
			where: { id: THREAD_ID },
			select: { id: true },
		});
		expect(createdWith().id).toBe(THREAD_ID);
		expect(conversation.id).toBe(THREAD_ID);
		expect(join.conversationId).toBe(THREAD_ID);
	});

	it("ignores a proposed id an existing conversation already has", async () => {
		// Whoever owns it — the lookup does not even read the owner, because
		// no existing conversation may ever be adopted through a proposal.
		findUnique.mockResolvedValue({ id: THREAD_ID });

		const { conversation, join } = await create(THREAD_ID);

		expect("id" in createdWith()).toBe(false);
		expect(conversation.id).toBe("cuid-generated");
		expect(join.conversationId).toBe("cuid-generated");
	});

	it("lets the database generate the id when nothing is proposed", async () => {
		await create();

		expect(findUnique).not.toHaveBeenCalled();
		expect("id" in createdWith()).toBe(false);
	});
});
