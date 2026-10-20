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

// Fizzy #3086: a reply served by the member's own key says so, by provider.
describe("a reply on the member's personal key", () => {
	const PERSONAL = "x-fabric-chatgpt-plan-personal-key";

	it("reads the provider the stream names, alongside the reset", () => {
		expect(
			readChatGptPlanApiBilling(
				new Response("", {
					headers: {
						[HEADER]: RESET,
						[PERSONAL]: "ANTHROPIC_DIRECT",
					},
				}),
			),
		).toEqual({ resetAt: RESET, personalKeyProvider: "ANTHROPIC_DIRECT" });
	});

	it("keeps the provider with the saved message", () => {
		expect(
			parseChatGptPlanApiBilling({
				resetAt: RESET,
				personalKeyProvider: "OPENAI_DIRECT",
			}),
		).toEqual({ resetAt: RESET, personalKeyProvider: "OPENAI_DIRECT" });
		expect(
			parseChatGptPlanApiBilling({
				resetAt: RESET,
				personalKeyProvider: 7,
			}),
		).toEqual({ resetAt: RESET });
	});

	it("says the reply used the personal key, naming its provider and the reset", () => {
		render(
			<ApiBillingNotice
				apiBilling={{
					resetAt: RESET,
					personalKeyProvider: "ANTHROPIC_DIRECT",
				}}
			/>,
		);
		const notice = screen.getByTestId("chatgpt-plan-api-billing-notice");
		expect(notice).toHaveTextContent(
			/^This reply used your personal Anthropic key because the ChatGPT plan is spent\. Plans reset at .+\.$/,
		);
		expect(notice).not.toHaveTextContent(/API billing/);
	});

	it("drops the reset when it is unknown", () => {
		expect(
			chatGptPlanApiBillingNote({
				resetAt: null,
				personalKeyProvider: "OPENAI_DIRECT",
			}),
		).toBe(
			"This reply used your personal OpenAI key because the ChatGPT plan is spent.",
		);
	});
});
