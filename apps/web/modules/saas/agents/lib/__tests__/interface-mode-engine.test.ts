import { describe, expect, it } from "vitest";
import {
	type ChatEngine,
	type ChatEngineInput,
	conversationEngineFromMetadata,
	resolveChatEngine,
} from "../interface-mode-engine";

/**
 * Pins engine selection on the unified interface (Fizzy #2040).
 *
 * The regression this guards: moving simple mode onto the Orchestrator must
 * not move existing threads with it. The Orchestrator only hydrates its own
 * conversations, so a Direct thread opened on it renders blank and then gets
 * its metadata rewritten. An open conversation therefore keeps the engine it
 * was recorded with.
 */
function input(overrides: Partial<ChatEngineInput>): ChatEngineInput {
	return {
		uiMode: "simple",
		useOrchestrator: false,
		deepResearch: false,
		conversationEngine: null,
		isAgentInstance: false,
		...overrides,
	};
}

describe("resolveChatEngine", () => {
	describe("new chat", () => {
		it("runs the orchestrator in simple mode whatever the hidden tab says", () => {
			for (const useOrchestrator of [true, false]) {
				for (const deepResearch of [true, false]) {
					expect(
						resolveChatEngine(
							input({ useOrchestrator, deepResearch }),
						),
					).toBe("orchestrator");
				}
			}
		});

		it("follows the Direct tab in advanced mode", () => {
			expect(resolveChatEngine(input({ uiMode: "advanced" }))).toBe(
				"direct",
			);
		});

		it("follows the Orchestrator tab in advanced mode", () => {
			expect(
				resolveChatEngine(
					input({ uiMode: "advanced", useOrchestrator: true }),
				),
			).toBe("orchestrator");
		});

		it("follows the Research tab in advanced mode", () => {
			expect(
				resolveChatEngine(
					input({ uiMode: "advanced", deepResearch: true }),
				),
			).toBe("research");
			expect(
				resolveChatEngine(
					input({
						uiMode: "advanced",
						deepResearch: true,
						useOrchestrator: true,
					}),
				),
			).toBe("research");
		});
	});

	describe("open conversation", () => {
		const recorded: ChatEngine[] = ["direct", "orchestrator", "research"];

		it("keeps a Direct thread on Direct in both modes", () => {
			for (const uiMode of ["simple", "advanced"] as const) {
				expect(
					resolveChatEngine(
						input({
							uiMode,
							useOrchestrator: true,
							conversationEngine: "direct",
						}),
					),
				).toBe("direct");
			}
		});

		it("keeps an Orchestrator thread on the Orchestrator in both modes", () => {
			for (const uiMode of ["simple", "advanced"] as const) {
				expect(
					resolveChatEngine(
						input({ uiMode, conversationEngine: "orchestrator" }),
					),
				).toBe("orchestrator");
			}
		});

		it("opens a Research thread as Research in advanced mode", () => {
			expect(
				resolveChatEngine(
					input({
						uiMode: "advanced",
						conversationEngine: "research",
					}),
				),
			).toBe("research");
		});

		it("never runs Research in simple mode — the thread opens on Direct", () => {
			expect(
				resolveChatEngine(
					input({
						uiMode: "simple",
						deepResearch: true,
						conversationEngine: "research",
					}),
				),
			).toBe("direct");
		});

		it("ignores the engine tabs once a conversation is recorded", () => {
			for (const engine of recorded) {
				const a = resolveChatEngine(
					input({
						uiMode: "advanced",
						conversationEngine: engine,
						useOrchestrator: true,
					}),
				);
				const b = resolveChatEngine(
					input({
						uiMode: "advanced",
						conversationEngine: engine,
						deepResearch: true,
					}),
				);
				expect(a).toBe(engine);
				expect(b).toBe(engine);
			}
		});
	});

	describe("agent-instance chat", () => {
		it("runs Direct in every mode and for every recorded engine", () => {
			for (const uiMode of ["simple", "advanced"] as const) {
				for (const conversationEngine of [
					null,
					"direct",
					"orchestrator",
					"research",
				] as const) {
					expect(
						resolveChatEngine(
							input({
								uiMode,
								conversationEngine,
								useOrchestrator: true,
								deepResearch: true,
								isAgentInstance: true,
							}),
						),
					).toBe("direct");
				}
			}
		});
	});

	it("never returns Research in simple mode", () => {
		for (const conversationEngine of [
			null,
			"direct",
			"orchestrator",
			"research",
		] as const) {
			for (const deepResearch of [true, false]) {
				expect(
					resolveChatEngine(
						input({ conversationEngine, deepResearch }),
					),
				).not.toBe("research");
			}
		}
	});
});

describe("conversationEngineFromMetadata", () => {
	it("reads the recorded engine", () => {
		expect(conversationEngineFromMetadata({ mode: "orchestrator" })).toBe(
			"orchestrator",
		);
		expect(conversationEngineFromMetadata({ mode: "research" })).toBe(
			"research",
		);
		expect(conversationEngineFromMetadata({ mode: "direct" })).toBe(
			"direct",
		);
	});

	it("treats a thread without a recognised mode as Direct", () => {
		expect(conversationEngineFromMetadata(null)).toBe("direct");
		expect(conversationEngineFromMetadata(undefined)).toBe("direct");
		expect(conversationEngineFromMetadata({})).toBe("direct");
		expect(conversationEngineFromMetadata({ mode: "unknown" })).toBe(
			"direct",
		);
	});
});
