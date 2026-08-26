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

	it("merges selected tool ids with existing metadata", () => {
		const metadata = mergeDirectConversationMetadata({
			existing: { mode: "direct", custom: true },
			documentChatId: "chat-1",
			instanceId: "inst-1",
			selectedMcpConfigIds: ["cfg-9"],
		});

		expect(metadata).toMatchObject({
			mode: "direct",
			custom: true,
			documentChatId: "chat-1",
			instanceId: "inst-1",
			selectedMcpConfigIds: ["cfg-9"],
		});
	});

	it("removes explicit tool selection when resetting to defaults", () => {
		const metadata = mergeDirectConversationMetadata({
			existing: { selectedMcpConfigIds: ["cfg-9"], mode: "direct" },
		});

		expect(metadata).toEqual({ mode: "direct" });
	});
});
