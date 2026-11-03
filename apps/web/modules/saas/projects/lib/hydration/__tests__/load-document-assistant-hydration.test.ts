// @vitest-environment node
/**
 * The SSR hydration of the document assistant sidebar shows the caller's
 * active thread on a document only when they can see the document's project,
 * the check the thread procedures make, and only when the document is in the
 * project the page names. On a refusal it loads no thread and logs nothing:
 * a refusal is not a failed load.
 *
 * The project check is the real one, over a mocked `@repo/database` that
 * answers from the documents, project access and active threads each test
 * sets up.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const store = {
		/** Document id → the project its own row names. */
		documents: new Map<string, string>(),
		/** `${projectId}:${userId}` pairs `hasProjectAccess` answers true for. */
		access: new Set<string>(),
	};
	return {
		store,
		getActiveDocumentAssistantConversation: vi.fn(),
		organizationFindUnique: vi.fn(),
		getDocumentRefProjectId: vi.fn(
			async ({ documentRefId }: { documentRefId: string }) =>
				store.documents.get(documentRefId) ?? null,
		),
		hasProjectAccess: vi.fn(async (projectId: string, userId: string) =>
			store.access.has(`${projectId}:${userId}`),
		),
		warn: vi.fn(),
	};
});

vi.mock("@repo/database", () => ({
	db: { organization: { findUnique: mocks.organizationFindUnique } },
	getActiveDocumentAssistantConversation:
		mocks.getActiveDocumentAssistantConversation,
	getDocumentRefProjectId: mocks.getDocumentRefProjectId,
	hasProjectAccess: mocks.hasProjectAccess,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		warn: mocks.warn,
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// The shared document-assistant helpers re-export two schemas from this
// procedure file, whose procedure chain the loader never runs.
vi.mock(
	"@repo/api/modules/agents/procedures/conversations/update-conversation",
	() => ({ MessageSchema: {}, maybeStripReasoning: vi.fn() }),
);

import { loadDocumentAssistantHydration } from "../load-document-assistant-hydration";

const ORG_ID = "org-example-1";
const PROJECT_P = "proj-example-p";
const PROJECT_Q = "proj-example-q";
const DOCUMENT_ID = "doc-example-1";

const activeRow = {
	id: "join-example-1",
	conversationId: "conv-example-1",
	visibility: "SHARED",
	visibilityLockedAt: new Date("2026-10-29T09:00:00.000Z"),
	createdAt: new Date("2026-10-29T08:00:00.000Z"),
	updatedAt: new Date("2026-10-29T09:30:00.000Z"),
	conversation: {
		title: "Example thread",
		messages: [{ id: "msg-example-1", role: "user", content: "Hello" }],
		parentConversationId: null,
		agentId: "doc-agent",
	},
};

const expectedConversation = {
	id: "join-example-1",
	conversationId: "conv-example-1",
	title: "Example thread",
	visibility: "SHARED",
	visibilityLockedAt: "2026-10-29T09:00:00.000Z",
	messages: [{ id: "msg-example-1", role: "user", content: "Hello" }],
	parentConversationId: null,
	agentId: "doc-agent",
	createdAt: "2026-10-29T08:00:00.000Z",
	updatedAt: "2026-10-29T09:30:00.000Z",
};

function load(userId: string) {
	return loadDocumentAssistantHydration({
		userId,
		organizationId: ORG_ID,
		projectId: PROJECT_P,
		documentRefKind: "PROJECT_DOCUMENT",
		documentRefId: DOCUMENT_ID,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.store.documents.clear();
	mocks.store.access.clear();
	mocks.store.documents.set(DOCUMENT_ID, PROJECT_P);
	mocks.organizationFindUnique.mockResolvedValue({
		documentAssistantHistoryEnabled: true,
	});
	mocks.getActiveDocumentAssistantConversation.mockResolvedValue(activeRow);
});

describe("loadDocumentAssistantHydration", () => {
	it("loads no thread for a member without access to the project, and logs nothing", async () => {
		await expect(load("user-example-outsider")).resolves.toEqual({
			conversation: null,
		});

		expect(
			mocks.getActiveDocumentAssistantConversation,
		).not.toHaveBeenCalled();
		expect(mocks.warn).not.toHaveBeenCalled();
	});

	it.each([
		["a project guest", "user-example-guest"],
		["a member on the project", "user-example-member"],
	])("loads the active thread for %s", async (_who, userId) => {
		mocks.store.access.add(`${PROJECT_P}:${userId}`);

		await expect(load(userId)).resolves.toEqual({
			conversation: expectedConversation,
		});
	});

	it("loads no thread for a document outside the page's project", async () => {
		mocks.store.documents.set(DOCUMENT_ID, PROJECT_Q);
		mocks.store.access.add(`${PROJECT_P}:user-example-member`);
		mocks.store.access.add(`${PROJECT_Q}:user-example-member`);

		await expect(load("user-example-member")).resolves.toEqual({
			conversation: null,
		});
		expect(
			mocks.getActiveDocumentAssistantConversation,
		).not.toHaveBeenCalled();
	});
});
