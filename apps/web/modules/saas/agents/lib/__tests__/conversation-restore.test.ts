import { describe, expect, it } from "vitest";
import {
	drawerEngineFor,
	restoreFromConversationMetadata,
} from "../conversation-restore";

describe("restoreFromConversationMetadata", () => {
	it("reads the mode, the reasoning mode, the document chat and the instance a conversation was conducted with", () => {
		expect(
			restoreFromConversationMetadata({
				mode: "orchestrator",
				executionMode: "deep",
				documentChatId: "doc-chat-1",
				instanceId: "instance-1",
			}),
		).toEqual({
			mode: "orchestrator",
			engine: "orchestrator",
			reasoningMode: "deep",
			documentChatId: "doc-chat-1",
			instanceId: "instance-1",
		});
	});

	it.each([
		["direct", "direct"],
		["orchestrator", "orchestrator"],
		["research", "research"],
	] as const)("runs a %s conversation on the %s engine", (mode, engine) => {
		expect(restoreFromConversationMetadata({ mode })).toMatchObject({
			mode,
			engine,
		});
	});

	it.each([
		["a conversation with no metadata", null],
		["metadata that is not an object", "orchestrator"],
		["metadata without a mode", {}],
		["a mode nobody records", { mode: "streaming" }],
	])(
		"opens %s on Direct, with nothing else to restore",
		(_label, metadata) => {
			expect(restoreFromConversationMetadata(metadata)).toEqual({
				mode: null,
				engine: "direct",
				reasoningMode: null,
				documentChatId: null,
				instanceId: null,
			});
		},
	);

	it("reads every reasoning mode the selector offers, and ignores one it does not", () => {
		for (const executionMode of ["lite", "balanced", "deep", "planner"]) {
			expect(
				restoreFromConversationMetadata({ executionMode })
					.reasoningMode,
			).toBe(executionMode);
		}
		expect(
			restoreFromConversationMetadata({ executionMode: "turbo" })
				.reasoningMode,
		).toBeNull();
	});

	it("runs a conversation that records no mode on the engine it is given, and one that records a mode on its own", () => {
		expect(
			restoreFromConversationMetadata(null, "orchestrator"),
		).toMatchObject({
			mode: "orchestrator",
			engine: "orchestrator",
		});
		expect(
			restoreFromConversationMetadata({ mode: "direct" }, "orchestrator"),
		).toMatchObject({ mode: "direct", engine: "direct" });
		expect(restoreFromConversationMetadata(null)).toMatchObject({
			mode: null,
			engine: "direct",
		});
	});

	it("takes a document chat or an instance only when it is a non-empty string", () => {
		expect(
			restoreFromConversationMetadata({
				documentChatId: "",
				instanceId: 7,
			}),
		).toMatchObject({ documentChatId: null, instanceId: null });
	});
});

describe("drawerEngineFor", () => {
	it("keeps the Orchestrator and the Direct engines, and opens Research on Direct", () => {
		expect(drawerEngineFor("orchestrator")).toBe("orchestrator");
		expect(drawerEngineFor("direct")).toBe("direct");
		expect(drawerEngineFor("research")).toBe("direct");
	});
});
