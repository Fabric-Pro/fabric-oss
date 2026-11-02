import { describe, expect, it } from "vitest";
import { selectDocumentAssistantMessages } from "../../components/copilot/document-assistant-message-projection";
import { findDiffProposal } from "../find-diff-proposal";

describe("findDiffProposal", () => {
	it.each([
		["", "text"],
		["Own text", "proposal"],
	])("matches persistence for proposal content %j", (content, messageId) => {
		const messages = selectDocumentAssistantMessages({
			messages: [
				{ id: "text", role: "assistant", content: "Earlier text" },
				{
					id: "proposal",
					role: "assistant",
					content,
					toolCalls: [
						{ id: "call", function: { name: "confirm_changes" } },
					],
				},
			],
		} as Parameters<typeof selectDocumentAssistantMessages>[0]);
		expect(findDiffProposal(messages)).toEqual({
			messageId,
			toolCallId: "call",
		});
		expect(findDiffProposal([])).toBeNull();
		expect(
			findDiffProposal([
				{ ...messages[0], id: "boundary", role: "user" },
				{ ...messages[1], content: "" },
			]),
		).toEqual({ messageId: "proposal", toolCallId: "call" });
		expect(
			findDiffProposal([
				{
					...messages[0],
					id: "action",
					name: "write_document_local",
					parentMessageId: "parent",
					isActionExecutionMessage: () => true,
				},
			]),
		).toEqual({ messageId: "parent", toolCallId: "action" });
		expect(
			findDiffProposal([
				{
					...messages[1],
					toolCalls: [
						{
							id: "legacy",
							name: "write_document_local",
							function: { name: undefined },
						},
					],
				},
			]),
		).toEqual({ messageId: "proposal", toolCallId: "legacy" });
	});
});
