import { FABRIC_AGENT_ID } from "@repo/utils/page-limits";
import { describe, expect, it } from "vitest";
import {
	type ConversationListItem,
	conversationListKey,
	conversationListPageOf,
	listFilterFor,
} from "../conversation-list";

type ListOutput = Parameters<typeof conversationListPageOf>[0];
type ListedConversation = ListOutput["conversations"][number];

const ITEM: ListedConversation = {
	id: "c1",
	agentId: FABRIC_AGENT_ID,
	title: "Quarterly plan",
	messageCount: 4,
	pinned: false,
	status: "ACTIVE",
	createdAt: "2026-10-14T09:00:00.000Z",
	updatedAt: "2026-10-14T10:00:00.000Z",
	lastMessage: "Here is the plan.",
	metadata: { mode: "orchestrator" },
	visibility: "ORGANIZATION",
	isOwn: false,
	owner: { id: "u2", name: "Sam Example" },
};

describe("conversationListPageOf", () => {
	it("reads the conversations of a page with who owns them and who may read them", () => {
		const page = conversationListPageOf({
			conversations: [ITEM],
			hasMore: true,
			nextCursor: "cursor-1",
		});

		const expected: ConversationListItem = {
			...ITEM,
			engine: "orchestrator",
		};
		expect(page.nextCursor).toBe("cursor-1");
		expect(page.items).toEqual([expected]);
	});

	it("reads the engine a conversation ran on from its metadata, Direct for an older one", () => {
		const page = conversationListPageOf({
			conversations: [
				{ ...ITEM, id: "a", metadata: { mode: "research" } },
				{ ...ITEM, id: "b", metadata: null },
			],
			hasMore: false,
		});

		expect(page.items.map((item) => item.engine)).toEqual([
			"research",
			"direct",
		]);
	});

	it("ends the list when the server hands out no cursor", () => {
		expect(
			conversationListPageOf({ conversations: [ITEM], hasMore: false })
				.nextCursor,
		).toBeNull();
	});
});

describe("listFilterFor", () => {
	it.each([
		["mine", { scope: "mine", status: "ACTIVE" }],
		["shared", { scope: "shared", status: "ACTIVE" }],
		["archived", { scope: "mine", status: "ARCHIVED" }],
	] as const)("asks for the %s view with %o", (view, filter) => {
		expect(listFilterFor(view)).toEqual(filter);
	});
});

describe("conversationListKey", () => {
	it("sits under the cache prefix every conversation change invalidates, and tells views and searches apart", () => {
		const mine = conversationListKey({
			organizationId: "org-1",
			agentId: "a",
			view: "mine",
			search: "",
		});
		const shared = conversationListKey({
			organizationId: "org-1",
			agentId: "a",
			view: "shared",
			search: "",
		});

		expect(mine.slice(0, 2)).toEqual(["agents", "conversations"]);
		expect(mine).not.toEqual(shared);
	});
});
