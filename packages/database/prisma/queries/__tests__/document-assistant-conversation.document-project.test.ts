/**
 * `getDocumentRefProjectId`: the project a document-assistant document ref
 * belongs to, read off the document's own table, so the procedures that
 * authorize the project authorize the document's and not the one the client
 * named.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { projectDocument, userStory, publishingTopic } = vi.hoisted(() => ({
	projectDocument: vi.fn(),
	userStory: vi.fn(),
	publishingTopic: vi.fn(),
}));

vi.mock("../../client", () => ({
	db: {
		projectDocument: { findUnique: projectDocument },
		userStory: { findUnique: userStory },
		publishingTopic: { findUnique: publishingTopic },
	},
}));

import { getDocumentRefProjectId } from "../document-assistant-conversation";

const QUERY = {
	where: { id: "ref-example-1" },
	select: { projectId: true },
};

beforeEach(() => {
	vi.clearAllMocks();
	projectDocument.mockResolvedValue({ projectId: "project-document" });
	userStory.mockResolvedValue({ projectId: "project-story" });
	publishingTopic.mockResolvedValue({ projectId: "project-topic" });
});

describe("getDocumentRefProjectId", () => {
	it.each([
		["PROJECT_DOCUMENT", projectDocument, "project-document"],
		["USER_STORY", userStory, "project-story"],
		["PUBLISHING_TOPIC", publishingTopic, "project-topic"],
	] as const)(
		"reads a %s ref's project off its own row",
		async (documentRefKind, table, projectId) => {
			await expect(
				getDocumentRefProjectId({
					documentRefKind,
					documentRefId: "ref-example-1",
				}),
			).resolves.toBe(projectId);

			expect(table).toHaveBeenCalledWith(QUERY);
			for (const other of [projectDocument, userStory, publishingTopic]) {
				if (other !== table) {
					expect(other).not.toHaveBeenCalled();
				}
			}
		},
	);

	it("is null for a ref that names no document", async () => {
		userStory.mockResolvedValue(null);

		await expect(
			getDocumentRefProjectId({
				documentRefKind: "USER_STORY",
				documentRefId: "ref-example-1",
			}),
		).resolves.toBeNull();
	});
});
