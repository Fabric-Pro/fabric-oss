import { describe, expect, it } from "vitest";
import {
	getSelectedConversationToolIds,
	mergeDirectConversationMetadata,
} from "../direct-chat-tools";

describe("direct chat tool metadata", () => {
	it("extracts selected tool ids from metadata", () => {
		expect(
			getSelectedConversationToolIds({
				selectedMcpConfigIds: ["cfg-1", "cfg-2"],
			}),
		).toEqual(["cfg-1", "cfg-2"]);
	});

	it("returns null when conversation metadata has no explicit tool selection", () => {
		expect(getSelectedConversationToolIds({ mode: "direct" })).toBeNull();
	});

	it("creates fresh Direct settings", () => {
		expect(
			mergeDirectConversationMetadata({
				documentChatId: "chat-1",
				instanceId: "inst-1",
				selectedMcpConfigIds: ["cfg-9"],
			}),
		).toEqual({
			mode: "direct",
			documentChatId: "chat-1",
			instanceId: "inst-1",
			selectedMcpConfigIds: ["cfg-9"],
		});
	});
	it("omits unset settings", () => {
		expect(mergeDirectConversationMetadata({ instanceId: null })).toEqual({
			mode: "direct",
		});
	});
});
