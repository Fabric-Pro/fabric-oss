/**
 * State Module Tests
 *
 * Tests for the Prompt Enhancer state annotation.
 */

import { describe, expect, it } from "vitest";
import { PromptEnhancerState, type PromptEnhancerStateType } from "../state";

describe("PromptEnhancerState", () => {
	describe("state structure", () => {
		it("should have all required channels", () => {
			const spec = PromptEnhancerState.spec;
			expect(spec).toHaveProperty("promptId");
			expect(spec).toHaveProperty("promptName");
			expect(spec).toHaveProperty("promptDescription");
			expect(spec).toHaveProperty("format");
			expect(spec).toHaveProperty("category");
			expect(spec).toHaveProperty("tags");
			expect(spec).toHaveProperty("currentContent");
			expect(spec).toHaveProperty("enhancementType");
			expect(spec).toHaveProperty("userInstructions");
			expect(spec).toHaveProperty("enhancedContent");
			expect(spec).toHaveProperty("explanation");
			expect(spec).toHaveProperty("streamingContent");
			expect(spec).toHaveProperty("focusAnchor");
			expect(spec).toHaveProperty("messages");
		});

		it("should be a valid LangGraph annotation", () => {
			expect(PromptEnhancerState).toBeDefined();
			expect(PromptEnhancerState.spec).toBeDefined();
		});

		it("should have promptId channel", () => {
			expect(PromptEnhancerState.spec.promptId).toBeDefined();
		});

		it("should have promptName channel", () => {
			expect(PromptEnhancerState.spec.promptName).toBeDefined();
		});

		it("should have currentContent channel", () => {
			expect(PromptEnhancerState.spec.currentContent).toBeDefined();
		});

		it("should have enhancedContent channel", () => {
			expect(PromptEnhancerState.spec.enhancedContent).toBeDefined();
		});

		it("should have streamingContent channel for AG-UI", () => {
			expect(PromptEnhancerState.spec.streamingContent).toBeDefined();
		});

		it("should have focusAnchor channel", () => {
			expect(PromptEnhancerState.spec.focusAnchor).toBeDefined();
		});

		it("should have format channel", () => {
			expect(PromptEnhancerState.spec.format).toBeDefined();
		});

		it("should have enhancementType channel", () => {
			expect(PromptEnhancerState.spec.enhancementType).toBeDefined();
		});

		it("should have tags channel", () => {
			expect(PromptEnhancerState.spec.tags).toBeDefined();
		});

		it("should have messages channel from MessagesAnnotation", () => {
			expect(PromptEnhancerState.spec.messages).toBeDefined();
		});
	});

	describe("type exports", () => {
		it("should export PromptEnhancerStateType", () => {
			// Type-level check - if this compiles, the type is exported correctly
			const mockState: PromptEnhancerStateType = {
				promptId: "test",
				promptName: "Test Prompt",
				promptDescription: undefined,
				currentContent: "content",
				enhancementType: "general",
				enhancedContent: "",
				explanation: "",
				streamingContent: "",
				format: "MARKDOWN",
				category: undefined,
				userInstructions: undefined,
				focusAnchor: undefined,
				retryCount: 0,
				error: undefined,
				tags: [],
				messages: [],
			};
			expect(mockState.promptId).toBe("test");
		});

		it("should allow optional fields", () => {
			const mockState: PromptEnhancerStateType = {
				promptId: "",
				promptName: "",
				promptDescription: "optional desc",
				currentContent: "",
				enhancementType: "general",
				enhancedContent: "",
				explanation: "",
				streamingContent: "",
				format: "PLAIN_TEXT",
				category: undefined,
				userInstructions: "optional instructions",
				focusAnchor: "## section",
				retryCount: 0,
				error: undefined,
				tags: [],
				messages: [],
			};
			expect(mockState.promptDescription).toBe("optional desc");
		});
	});
});

describe("Enhancement Types", () => {
	it("should support general as enhancement type", () => {
		const mockState: PromptEnhancerStateType = {
			promptId: "",
			promptName: "",
			promptDescription: undefined,
			currentContent: "",
			enhancementType: "general",
			enhancedContent: "",
			explanation: "",
			streamingContent: "",
			format: "PLAIN_TEXT",
			category: undefined,
			userInstructions: undefined,
			focusAnchor: undefined,
			retryCount: 0,
			error: undefined,
			tags: [],
			messages: [],
		};
		expect(mockState.enhancementType).toBe("general");
	});

	it("should support rewrite as enhancement type", () => {
		const mockState: PromptEnhancerStateType = {
			promptId: "",
			promptName: "",
			promptDescription: undefined,
			currentContent: "",
			enhancementType: "rewrite",
			enhancedContent: "",
			explanation: "",
			streamingContent: "",
			format: "PLAIN_TEXT",
			category: undefined,
			userInstructions: undefined,
			focusAnchor: undefined,
			retryCount: 0,
			error: undefined,
			tags: [],
			messages: [],
		};
		expect(mockState.enhancementType).toBe("rewrite");
	});

	it("should support expand as enhancement type", () => {
		const mockState: PromptEnhancerStateType = {
			promptId: "",
			promptName: "",
			promptDescription: undefined,
			currentContent: "",
			enhancementType: "expand",
			enhancedContent: "",
			explanation: "",
			streamingContent: "",
			format: "PLAIN_TEXT",
			category: undefined,
			userInstructions: undefined,
			focusAnchor: undefined,
			retryCount: 0,
			error: undefined,
			tags: [],
			messages: [],
		};
		expect(mockState.enhancementType).toBe("expand");
	});
});

describe("Prompt Formats", () => {
	it("should support PLAIN_TEXT format", () => {
		const mockState: PromptEnhancerStateType = {
			promptId: "",
			promptName: "",
			promptDescription: undefined,
			currentContent: "",
			enhancementType: "general",
			enhancedContent: "",
			explanation: "",
			streamingContent: "",
			format: "PLAIN_TEXT",
			category: undefined,
			userInstructions: undefined,
			focusAnchor: undefined,
			retryCount: 0,
			error: undefined,
			tags: [],
			messages: [],
		};
		expect(mockState.format).toBe("PLAIN_TEXT");
	});

	it("should support MARKDOWN format", () => {
		const mockState: PromptEnhancerStateType = {
			promptId: "",
			promptName: "",
			promptDescription: undefined,
			currentContent: "",
			enhancementType: "general",
			enhancedContent: "",
			explanation: "",
			streamingContent: "",
			format: "MARKDOWN",
			category: undefined,
			userInstructions: undefined,
			focusAnchor: undefined,
			retryCount: 0,
			error: undefined,
			tags: [],
			messages: [],
		};
		expect(mockState.format).toBe("MARKDOWN");
	});
});

describe("Streaming Support", () => {
	it("should have streamingContent for AG-UI protocol", () => {
		const spec = PromptEnhancerState.spec;
		expect(spec.streamingContent).toBeDefined();
	});

	it("should have focusAnchor for cursor positioning", () => {
		const spec = PromptEnhancerState.spec;
		expect(spec.focusAnchor).toBeDefined();
	});

	it("should allow setting streamingContent", () => {
		const mockState: PromptEnhancerStateType = {
			promptId: "",
			promptName: "",
			promptDescription: undefined,
			currentContent: "",
			enhancementType: "general",
			enhancedContent: "",
			explanation: "",
			streamingContent: "Partial content streaming...",
			format: "PLAIN_TEXT",
			category: undefined,
			userInstructions: undefined,
			focusAnchor: undefined,
			retryCount: 0,
			error: undefined,
			tags: [],
			messages: [],
		};
		expect(mockState.streamingContent).toBe("Partial content streaming...");
	});

	it("should allow setting focusAnchor", () => {
		const mockState: PromptEnhancerStateType = {
			promptId: "",
			promptName: "",
			promptDescription: undefined,
			currentContent: "",
			enhancementType: "general",
			enhancedContent: "",
			explanation: "",
			streamingContent: "",
			format: "PLAIN_TEXT",
			category: undefined,
			userInstructions: undefined,
			focusAnchor: "## Important Section",
			retryCount: 0,
			error: undefined,
			tags: [],
			messages: [],
		};
		expect(mockState.focusAnchor).toBe("## Important Section");
	});
});

describe("State with Messages", () => {
	it("should allow empty messages array", () => {
		const mockState: PromptEnhancerStateType = {
			promptId: "",
			promptName: "",
			promptDescription: undefined,
			currentContent: "",
			enhancementType: "general",
			enhancedContent: "",
			explanation: "",
			streamingContent: "",
			format: "PLAIN_TEXT",
			category: undefined,
			userInstructions: undefined,
			focusAnchor: undefined,
			retryCount: 0,
			error: undefined,
			tags: [],
			messages: [],
		};
		expect(mockState.messages).toEqual([]);
	});

	it("should allow messages with content", () => {
		const mockState: PromptEnhancerStateType = {
			promptId: "",
			promptName: "",
			promptDescription: undefined,
			currentContent: "",
			enhancementType: "general",
			enhancedContent: "",
			explanation: "",
			streamingContent: "",
			format: "PLAIN_TEXT",
			category: undefined,
			userInstructions: undefined,
			focusAnchor: undefined,
			retryCount: 0,
			error: undefined,
			tags: [],
			messages: [
				{ type: "human", content: "Enhance this prompt" },
			] as any,
		};
		expect(mockState.messages.length).toBe(1);
	});
});

describe("Tags support", () => {
	it("should allow empty tags array", () => {
		const mockState: PromptEnhancerStateType = {
			promptId: "",
			promptName: "",
			promptDescription: undefined,
			currentContent: "",
			enhancementType: "general",
			enhancedContent: "",
			explanation: "",
			streamingContent: "",
			format: "PLAIN_TEXT",
			category: undefined,
			userInstructions: undefined,
			focusAnchor: undefined,
			retryCount: 0,
			error: undefined,
			tags: [],
			messages: [],
		};
		expect(mockState.tags).toEqual([]);
	});

	it("should allow multiple tags", () => {
		const mockState: PromptEnhancerStateType = {
			promptId: "",
			promptName: "",
			promptDescription: undefined,
			currentContent: "",
			enhancementType: "general",
			enhancedContent: "",
			explanation: "",
			streamingContent: "",
			format: "PLAIN_TEXT",
			category: undefined,
			userInstructions: undefined,
			focusAnchor: undefined,
			retryCount: 0,
			error: undefined,
			tags: ["AI", "prompt", "enhancement"],
			messages: [],
		};
		expect(mockState.tags).toEqual(["AI", "prompt", "enhancement"]);
	});
});

// =============================================================================
// reasoningByTurn channel (PR 3/5 — reasoning surfacing extension)
// =============================================================================

describe("PromptEnhancerState — reasoningByTurn", () => {
	// LangGraph 1.x exposes a reducer-shaped Annotation as a
	// BinaryOperatorAggregate channel whose runtime fields are `operator`
	// (the reducer fn) and `initialValueFactory` (the default fn).
	type AggregateChannel = {
		operator: (
			a: Record<number, unknown> | undefined,
			b: Record<number, unknown> | undefined,
		) => Record<number, unknown>;
		initialValueFactory: () => Record<number, unknown>;
	};

	it("declares reasoningByTurn in the state spec", () => {
		expect(PromptEnhancerState.spec.reasoningByTurn).toBeDefined();
	});

	it("defaults to empty record", () => {
		const channel = PromptEnhancerState.spec
			.reasoningByTurn as unknown as AggregateChannel;
		expect(channel.initialValueFactory()).toEqual({});
	});

	it("merges incoming entries with existing (no overwrite of unrelated keys)", () => {
		const channel = PromptEnhancerState.spec
			.reasoningByTurn as unknown as AggregateChannel;
		const merged = channel.operator(
			{ 1: { text: "a", durationMs: 1, startedAt: 0, completedAt: 1 } },
			{ 2: { text: "b", durationMs: 2, startedAt: 1, completedAt: 3 } },
		);
		expect(merged).toEqual({
			1: { text: "a", durationMs: 1, startedAt: 0, completedAt: 1 },
			2: { text: "b", durationMs: 2, startedAt: 1, completedAt: 3 },
		});
	});

	it("overwrites same-key entries (mid-turn merge from enhance-node side)", () => {
		const channel = PromptEnhancerState.spec
			.reasoningByTurn as unknown as AggregateChannel;
		const merged = channel.operator(
			{ 1: { text: "old", durationMs: 1, startedAt: 0, completedAt: 1 } },
			{ 1: { text: "new", durationMs: 2, startedAt: 0, completedAt: 2 } },
		);
		expect((merged as Record<number, { text: string }>)[1].text).toBe(
			"new",
		);
	});
});
