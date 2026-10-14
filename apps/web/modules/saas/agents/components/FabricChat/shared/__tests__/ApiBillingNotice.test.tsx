/**
 * The note under a reply that ran on the organization's API billing because
 * every ChatGPT plan was spent (Fizzy #3048): read from the chat stream's
 * response, kept with the saved message, and said under the reply.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	chatGptPlanApiBillingNote,
	parseChatGptPlanApiBilling,
	readChatGptPlanApiBilling,
} from "../../../../lib/chatgpt-plan-api-billing";
import { ApiBillingNotice } from "../ApiBillingNotice";

const RESET = "2026-10-13T17:50:00.000Z";
const HEADER = "x-fabric-chatgpt-plan-api-billing";

describe("readChatGptPlanApiBilling", () => {
	it("reads the reset a marked stream carries", () => {
		expect(
			readChatGptPlanApiBilling(
				new Response("", { headers: { [HEADER]: RESET } }),
			),
		).toEqual({ resetAt: RESET });
	});

	it("reads a marked stream with no known reset", () => {
		expect(
			readChatGptPlanApiBilling(
				new Response("", { headers: { [HEADER]: "" } }),
			),
		).toEqual({ resetAt: null });
	});

	it("reads nothing from an unmarked stream", () => {
		expect(readChatGptPlanApiBilling(new Response(""))).toBeUndefined();
	});
});

describe("parseChatGptPlanApiBilling", () => {
	it("restores the marker a saved message holds", () => {
		expect(parseChatGptPlanApiBilling({ resetAt: RESET })).toEqual({
			resetAt: RESET,
		});
		expect(parseChatGptPlanApiBilling({ resetAt: "soon" })).toEqual({
			resetAt: null,
		});
		expect(parseChatGptPlanApiBilling(undefined)).toBeUndefined();
	});
});

describe("ApiBillingNotice", () => {
	it("says the reply ran on API billing, and when the plans reset", () => {
		const now = new Date(RESET);
		expect(chatGptPlanApiBillingNote({ resetAt: RESET }, now)).toMatch(
			/^This reply ran on API billing because every ChatGPT plan is spent\. Plans reset at .+\.$/,
		);
		render(<ApiBillingNotice apiBilling={{ resetAt: RESET }} />);
		expect(
			screen.getByTestId("chatgpt-plan-api-billing-notice"),
		).toHaveTextContent(
			/This reply ran on API billing because every ChatGPT plan is spent\. Plans reset at/,
		);
	});

	it("drops the reset when it is unknown", () => {
		render(<ApiBillingNotice apiBilling={{ resetAt: null }} />);
		expect(
			screen.getByTestId("chatgpt-plan-api-billing-notice"),
		).toHaveTextContent(
			/^This reply ran on API billing because every ChatGPT plan is spent\.$/,
		);
	});
});
