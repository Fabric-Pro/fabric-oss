import { describe, expect, it } from "vitest";
import {
	getConversationPlanModel,
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

	it("keeps the chat's plan model in a new conversation", () => {
		const planModel = { canonicalName: "gpt-6-luna", name: "GPT-6 Luna" };

		const metadata = mergeDirectConversationMetadata({ planModel });

		expect(metadata).toEqual({ mode: "direct", planModel });
		expect(getConversationPlanModel(metadata)).toEqual(planModel);
	});

	it("reads no plan model from metadata without a valid one", () => {
		for (const metadata of [
			null,
			{ mode: "direct" },
			{ planModel: null },
			{ planModel: { canonicalName: "", name: "Empty" } },
			{ planModel: { name: "No canonical name" } },
		]) {
			expect(getConversationPlanModel(metadata)).toBeNull();
		}
	});
});
