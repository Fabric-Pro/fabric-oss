/**
 * `getDocumentAssistantThreadRef`: the document and project a
 * document-assistant thread is about, read off the thread's own join row, so
 * the realtime route can ask whether the caller sees that document's project.
 * A conversation with no join row is not a document-assistant thread.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type JoinRow = Record<string, unknown> & { conversationId: string };

const { rows, findFirst } = vi.hoisted(() => {
	const rows: JoinRow[] = [];
	// Answers like Prisma: the first row with the asked conversation id,
	// narrowed to the selected fields.
	const findFirst = vi.fn(
		async ({
			where,
			select,
		}: {
			where: { conversationId: string };
			select: Record<string, boolean>;
		}) => {
			const row = rows.find(
				(candidate) =>
					candidate.conversationId === where.conversationId,
			);
			if (!row) {
				return null;
			}
			return Object.fromEntries(
				Object.keys(select)
					.filter((key) => select[key])
					.map((key) => [key, row[key]]),
			);
		},
	);
	return { rows, findFirst };
});

vi.mock("../../client", () => ({
	db: {
		documentAssistantConversation: { findFirst },
	},
}));

import { getDocumentAssistantThreadRef } from "../document-assistant-conversation";

beforeEach(() => {
	vi.clearAllMocks();
	rows.length = 0;
	rows.push(
		{
			id: "join-example-1",
			conversationId: "conv-example-1",
			documentRefKind: "USER_STORY",
			documentRefId: "story-example-1",
			projectId: "proj-example-p",
			organizationId: "org-example-1",
			userId: "user-example-owner",
			visibility: "SHARED",
		},
		{
			id: "join-example-2",
			conversationId: "conv-example-2",
			documentRefKind: "PROJECT_DOCUMENT",
			documentRefId: "doc-example-2",
			projectId: "proj-example-q",
			organizationId: "org-example-1",
			userId: "user-example-other",
			visibility: "PRIVATE",
		},
	);
});

describe("getDocumentAssistantThreadRef", () => {
	it("returns the thread's document ref and project from its join row", async () => {
		await expect(
			getDocumentAssistantThreadRef({ conversationId: "conv-example-1" }),
		).resolves.toEqual({
			documentRefKind: "USER_STORY",
			documentRefId: "story-example-1",
			projectId: "proj-example-p",
		});
	});

	it("is null for a conversation without a join row", async () => {
		await expect(
			getDocumentAssistantThreadRef({
				conversationId: "conv-example-standalone",
			}),
		).resolves.toBeNull();
	});
});
