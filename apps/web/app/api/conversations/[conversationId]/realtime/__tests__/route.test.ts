// @vitest-environment node
/**
 * Who may open the realtime stream of a conversation.
 *
 * A document-assistant thread is about a document, and the thread procedures
 * show it only to a caller who can see the project that document belongs to.
 * The stream follows the same rule: on top of owning the thread, or it being
 * SHARED in the caller's organization, the caller must have access to the
 * document's own project, and the document must still be in the project the
 * thread names. A refusal is the 404 a missing conversation gets. A
 * conversation that is not a document-assistant thread stays owner-only.
 *
 * `@upstash/realtime`'s `handle` is mocked to run the route's middleware: its
 * Response is the refusal, and `undefined` lets the stream open (200 here).
 * The project check itself is the real one, over a mocked `@repo/database`
 * that answers from the documents and project access each test sets up.
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type ThreadRef = {
	documentRefKind: "PROJECT_DOCUMENT" | "USER_STORY" | "PUBLISHING_TOPIC";
	documentRefId: string;
	projectId: string;
};

const mocks = vi.hoisted(() => {
	const store = {
		/** Document id → the project its own row names. */
		documents: new Map<string, string>(),
		/** `${projectId}:${userId}` pairs `hasProjectAccess` answers true for. */
		access: new Set<string>(),
	};
	return {
		store,
		getSession: vi.fn(),
		getAgentConversationById: vi.fn(),
		canSubscribeToDocumentAssistantConversation: vi.fn(),
		getDocumentAssistantThreadRef: vi.fn(),
		getDocumentRefProjectId: vi.fn(
			async ({ documentRefId }: { documentRefId: string }) =>
				store.documents.get(documentRefId) ?? null,
		),
		hasProjectAccess: vi.fn(async (projectId: string, userId: string) =>
			store.access.has(`${projectId}:${userId}`),
		),
	};
});

vi.mock("@upstash/realtime", () => ({
	handle:
		({
			middleware,
		}: {
			middleware: (args: {
				request: Request;
				channels: string[];
			}) => Promise<Response | undefined>;
		}) =>
		async (request: Request) =>
			(await middleware({ request, channels: [] })) ??
			new Response("stream", { status: 200 }),
}));

vi.mock("@repo/api/lib/realtime", () => ({
	getProjectRealtime: () => ({}),
	getConversationChannelName: (id: string) => `conversation:${id}`,
}));

vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: mocks.getSession } },
}));

vi.mock("next/headers", () => ({
	headers: async () => new Headers(),
}));

vi.mock("@repo/database/prisma/queries/agent-conversations", () => ({
	getAgentConversationById: mocks.getAgentConversationById,
}));

vi.mock(
	"@repo/database/prisma/queries/document-assistant-conversation",
	() => ({
		canSubscribeToDocumentAssistantConversation:
			mocks.canSubscribeToDocumentAssistantConversation,
		getDocumentAssistantThreadRef: mocks.getDocumentAssistantThreadRef,
	}),
);

vi.mock("@repo/database", () => ({
	db: {},
	getDocumentRefProjectId: mocks.getDocumentRefProjectId,
	hasProjectAccess: mocks.hasProjectAccess,
}));

// The shared document-assistant helpers re-export two schemas from this
// procedure file, whose procedure chain the route never runs.
vi.mock(
	"@repo/api/modules/agents/procedures/conversations/update-conversation",
	() => ({ MessageSchema: {}, maybeStripReasoning: vi.fn() }),
);

import { GET } from "../route";

const CONVERSATION_ID = "conv-example-1";
const PROJECT_P = "proj-example-p";
const PROJECT_Q = "proj-example-q";
const DOCUMENT_ID = "doc-example-1";
const ORG_ID = "org-example-1";

const threadOnP: ThreadRef = {
	documentRefKind: "PROJECT_DOCUMENT",
	documentRefId: DOCUMENT_ID,
	projectId: PROJECT_P,
};

function signIn(userId: string, activeOrganizationId: string | null) {
	mocks.getSession.mockResolvedValue({
		user: { id: userId },
		session: { activeOrganizationId },
	});
}

function grantAccess(projectId: string, userId: string) {
	mocks.store.access.add(`${projectId}:${userId}`);
}

async function subscribe() {
	return GET(
		new NextRequest(
			`https://app.example.com/api/conversations/${CONVERSATION_ID}/realtime`,
		),
		{ params: Promise.resolve({ conversationId: CONVERSATION_ID }) },
	);
}

async function expectNotFound(response: Response) {
	expect(response.status).toBe(404);
	await expect(response.json()).resolves.toEqual({
		error: "Conversation not found",
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.store.documents.clear();
	mocks.store.access.clear();
	mocks.store.documents.set(DOCUMENT_ID, PROJECT_P);
	mocks.getAgentConversationById.mockResolvedValue(null);
	mocks.canSubscribeToDocumentAssistantConversation.mockResolvedValue(false);
	mocks.getDocumentAssistantThreadRef.mockResolvedValue(null);
});

describe("GET /api/conversations/[conversationId]/realtime", () => {
	describe("a document-assistant thread", () => {
		beforeEach(() => {
			mocks.getDocumentAssistantThreadRef.mockResolvedValue(threadOnP);
		});

		it("refuses another member's SHARED thread to an organization member who is not on the document's project", async () => {
			signIn("user-example-outsider", ORG_ID);
			// SHARED in the caller's organization, so the thread itself lets
			// them in; the project does not.
			mocks.canSubscribeToDocumentAssistantConversation.mockResolvedValue(
				true,
			);

			await expectNotFound(await subscribe());
		});

		it("refuses the thread's owner after they lose access to the project", async () => {
			signIn("user-example-owner", ORG_ID);
			mocks.getAgentConversationById.mockResolvedValue({
				id: CONVERSATION_ID,
				userId: "user-example-owner",
			});
			mocks.canSubscribeToDocumentAssistantConversation.mockResolvedValue(
				true,
			);

			await expectNotFound(await subscribe());
		});

		it("opens for a project guest on their own thread", async () => {
			// The guest's session is rooted in their own organization, so the
			// session-organization owner lookup misses; the thread's join row
			// names them as its owner.
			signIn("user-example-guest", "org-example-guest-home");
			mocks.canSubscribeToDocumentAssistantConversation.mockResolvedValue(
				true,
			);
			grantAccess(PROJECT_P, "user-example-guest");

			const response = await subscribe();

			expect(response.status).toBe(200);
		});

		it("opens for a member on the project subscribing to a SHARED thread", async () => {
			signIn("user-example-member", ORG_ID);
			mocks.canSubscribeToDocumentAssistantConversation.mockResolvedValue(
				true,
			);
			grantAccess(PROJECT_P, "user-example-member");

			const response = await subscribe();

			expect(response.status).toBe(200);
		});

		it("refuses a thread whose document now belongs to another project", async () => {
			signIn("user-example-member", ORG_ID);
			mocks.canSubscribeToDocumentAssistantConversation.mockResolvedValue(
				true,
			);
			mocks.store.documents.set(DOCUMENT_ID, PROJECT_Q);
			grantAccess(PROJECT_P, "user-example-member");
			grantAccess(PROJECT_Q, "user-example-member");

			await expectNotFound(await subscribe());
		});
	});

	describe("a conversation that is not a document-assistant thread", () => {
		it("opens for its owner, with no project involved", async () => {
			signIn("user-example-owner", ORG_ID);
			mocks.getAgentConversationById.mockResolvedValue({
				id: CONVERSATION_ID,
				userId: "user-example-owner",
			});

			const response = await subscribe();

			expect(response.status).toBe(200);
		});

		it("refuses anyone else", async () => {
			signIn("user-example-member", ORG_ID);
			grantAccess(PROJECT_P, "user-example-member");

			await expectNotFound(await subscribe());
		});
	});
});
