import { describe, expect, it } from "vitest";
import {
	applyConversationMcpSelection,
	buildChatToolSelectionPayload,
	resolveSelectedChatToolIds,
} from "../chat-tool-selection";

describe("chat-tool-selection", () => {
	it("treats default mode as null selection", () => {
		expect(
			resolveSelectedChatToolIds({
				toolSelectionMode: "DEFAULT",
				selectedMcpConfigIds: ["cfg-1"],
			}),
		).toBeNull();
	});

	it("keeps explicit disabled mode as empty array", () => {
		expect(
			resolveSelectedChatToolIds({
				toolSelectionMode: "DISABLED",
				selectedMcpConfigIds: [],
			}),
		).toEqual([]);
	});

	it("builds default payload from null", () => {
		expect(buildChatToolSelectionPayload(null)).toEqual({
			selectedMcpConfigIds: [],
			toolSelectionMode: "DEFAULT",
		});
	});

	it("builds disabled payload from empty selection", () => {
		expect(buildChatToolSelectionPayload([])).toEqual({
			selectedMcpConfigIds: [],
			toolSelectionMode: "DISABLED",
		});
	});

	it("keeps existing MCP config ids when conversation selection uses defaults", () => {
		expect(applyConversationMcpSelection(["cfg-1"], null)).toEqual([
			"cfg-1",
		]);
	});

	it("replaces existing MCP config ids when conversation selection is explicit", () => {
		expect(
			applyConversationMcpSelection(["cfg-1", "cfg-2"], ["cfg-9"]),
		).toEqual(["cfg-9"]);
	});

	it("allows explicit empty selection to disable MCP", () => {
		expect(applyConversationMcpSelection(["cfg-1"], [])).toEqual([]);
	});
});
