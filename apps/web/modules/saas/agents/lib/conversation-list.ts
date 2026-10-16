import type { InferClientOutputs } from "@orpc/client";
import type { ApiRouterClient } from "@repo/api/orpc/router";
import { restoreFromConversationMetadata } from "./conversation-restore";
import type { ChatEngine } from "./interface-mode-engine";

/**
 * The conversations Fabric Agent keeps, as the history list reads them. A
 * conversation is its owner's; its owner may share it with the organization,
 * and anyone in the organization can then read it (and carry on from it in a
 * chat of their own). The types are the procedures' own outputs, so a change to
 * what they return is a compile error here and not a blank row.
 */

type ConversationOutputs =
	InferClientOutputs<ApiRouterClient>["agents"]["conversations"];

/** A conversation opened: the messages and trajectory that parsed, and whose it is. */
export type ConversationDetail = ConversationOutputs["get"];

export type ConversationVisibility = ConversationDetail["visibility"];

/** Which conversations the list shows: the viewer's own, those shared with the organization, or the viewer's archived ones. */
export type ConversationView = "mine" | "shared" | "archived";

export type ConversationListItem =
	ConversationOutputs["list"]["conversations"][number] & {
		/** The engine the stored metadata says it ran on. */
		engine: ChatEngine;
	};

interface ConversationListPage {
	items: ConversationListItem[];
	/** Where the next page starts; null at the end of the list. */
	nextCursor: string | null;
}

export function conversationListPageOf(
	output: ConversationOutputs["list"],
): ConversationListPage {
	return {
		items: output.conversations.map((item) => ({
			...item,
			engine: restoreFromConversationMetadata(item.metadata).engine,
		})),
		nextCursor: output.nextCursor ?? null,
	};
}

export function conversationListKey(input: {
	organizationId: string | null | undefined;
	agentId: string;
	view: ConversationView;
	search: string;
}) {
	return ["agents", "conversations", "list-pages", input] as const;
}

/** What a view asks the list procedure for. */
export function listFilterFor(view: ConversationView): {
	scope: "mine" | "shared";
	status: "ACTIVE" | "ARCHIVED";
} {
	switch (view) {
		case "mine":
			return { scope: "mine", status: "ACTIVE" };
		case "shared":
			return { scope: "shared", status: "ACTIVE" };
		case "archived":
			return { scope: "mine", status: "ARCHIVED" };
		default: {
			const unreachable: never = view;
			return unreachable;
		}
	}
}
