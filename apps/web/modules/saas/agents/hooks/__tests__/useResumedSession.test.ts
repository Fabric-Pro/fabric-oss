import { describe, expect, it } from "vitest";
import type { ConversationDetail } from "../../lib/conversation-list";
import { launcherPaneOf } from "../useResumedSession";

const RESUMED = {
	id: "c1",
	title: "Quarterly plan",
	engine: "direct" as const,
	key: 1,
};

function detail(isOwn: boolean): ConversationDetail {
	return {
		id: "c1",
		agentId: "agent",
		title: "Quarterly plan",
		pinned: false,
		status: "ACTIVE",
		visibility: "ORGANIZATION",
		createdAt: "2026-10-14T09:00:00.000Z",
		updatedAt: "2026-10-14T10:00:00.000Z",
		metadata: null,
		isOwn,
		owner: { id: "u1", name: "Sam Example" },
		messages: [],
		trajectory: null,
		parentConversationId: null,
		carriedOverSummary: null,
		carriedOverAt: null,
	};
}

describe("launcherPaneOf", () => {
	it("is a new chat when nothing was reopened", () => {
		expect(
			launcherPaneOf(null, { data: undefined, isError: false }),
		).toEqual({ kind: "chat", conversation: null });
	});

	it("waits while the reopened conversation is being read", () => {
		expect(
			launcherPaneOf(RESUMED, { data: undefined, isError: false }),
		).toEqual({ kind: "loading" });
	});

	it("is gone only when the server says it is not there", () => {
		expect(launcherPaneOf(RESUMED, { data: null, isError: false })).toEqual(
			{
				kind: "gone",
			},
		);
	});

	it("is a failure, which is not the same as gone, when it could not be read", () => {
		expect(
			launcherPaneOf(RESUMED, { data: undefined, isError: true }),
		).toEqual({ kind: "error" });
	});

	it("is the chat, with its conversation, for one of the reader's own", () => {
		const own = detail(true);

		expect(launcherPaneOf(RESUMED, { data: own, isError: false })).toEqual({
			kind: "chat",
			conversation: own,
		});
	});

	it("is the read-only view for one another member shared", () => {
		const shared = detail(false);

		expect(
			launcherPaneOf(RESUMED, { data: shared, isError: false }),
		).toEqual({ kind: "shared", conversation: shared });
	});

	it("keeps what was loaded when a refresh of it fails, so a chat in progress is not replaced by an error", () => {
		const own = detail(true);

		expect(launcherPaneOf(RESUMED, { data: own, isError: true })).toEqual({
			kind: "chat",
			conversation: own,
		});
	});
});
