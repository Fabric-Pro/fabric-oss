import { describe, expect, it, vi } from "vitest";
import { createToolNarrator, narrationFor } from "../parlume-narration";
import { ParlumeSentenceQueue } from "../parlume-spoken-text";
import {
	prepareAgentTools,
	RUNTIME_TOOL_CONFIG_ID,
	withAgentToolRuntime,
} from "../shared/agent-tool-runtime";

const source = (originalName: string, configId = "builtin") => ({
	source: { configId, originalName },
});

describe("the line spoken when a tool starts", () => {
	it.each([
		["fabric_create_story", "Creating that now."],
		["create_ticket", "Creating that now."],
		["fabric_create_workflow", "Creating that now."],
		["fabric_list_project_features", "Let me check."],
		["search_slack_messages", "Let me check."],
		["fabric_get_project_document", "Let me check."],
		["fabric_list_meeting_transcripts", "Let me check."],
		["fabric_update_workflow", "On it."],
		["fabric_execute_workflow", "On it."],
	])("says the right thing for %s", (name, line) => {
		expect(narrationFor(source(name))).toBe(line);
	});

	it("says nothing for the meeting chat tool, which is quick and has its own line", () => {
		expect(
			narrationFor(
				source("post_to_meeting_chat", RUNTIME_TOOL_CONFIG_ID),
			),
		).toBeNull();
	});

	it("never names a tool, an argument or an address", () => {
		for (const name of ["fabric_create_story", "search_slack_messages"]) {
			const line = narrationFor(source(name)) ?? "";
			expect(line).not.toContain(name);
			expect(line).not.toMatch(/fabric_|https?:|_/);
		}
	});
});

describe("narrating a tool while it runs", () => {
	it("queues the fallback line before the tool executes, when the agent said nothing", async () => {
		const queue = new ParlumeSentenceQueue(800);
		const narrate = createToolNarrator(queue);
		const spoken: string[] = [];
		const speaker = (async () => {
			for await (const sentence of queue) {
				spoken.push(sentence);
			}
		})();

		await narrate(source("fabric_create_story"));
		queue.end();
		await speaker;

		expect(spoken).toEqual(["Creating that now."]);
	});

	it("speaks the fallback once per turn, not once per tool call", async () => {
		const queue = new ParlumeSentenceQueue(800);
		const narrate = createToolNarrator(queue);
		const spoken: string[] = [];
		const speaker = (async () => {
			for await (const sentence of queue) {
				spoken.push(sentence);
			}
		})();

		await narrate(source("fabric_list_project_features"));
		await narrate(source("fabric_create_story"));
		await narrate(source("fabric_get_project_document"));
		queue.end();
		await speaker;

		expect(spoken).toEqual(["Let me check."]);
	});

	it("adds no line when the agent already said its preamble, and speaks the preamble at once", async () => {
		const queue = new ParlumeSentenceQueue(800);
		const narrate = createToolNarrator(queue);
		const spoken: string[] = [];
		const speaker = (async () => {
			for await (const sentence of queue) {
				spoken.push(sentence);
			}
		})();
		queue.push("Checking the roadmap.");

		await narrate(source("fabric_list_project_features"));
		queue.end();
		await speaker;

		expect(spoken).toEqual(["Checking the roadmap."]);
	});

	it("releases a short preamble before the tool runs, without waiting for more text", async () => {
		const queue = new ParlumeSentenceQueue(800);
		const narrate = createToolNarrator(queue);
		const iterator = queue[Symbol.asyncIterator]();
		const first = iterator.next();
		queue.push("Let me look.");

		await narrate(source("fabric_get_project_feature"));

		await expect(
			Promise.race([
				first,
				new Promise((resolve) =>
					setTimeout(() => resolve("held"), 500),
				),
			]),
		).resolves.toEqual({ done: false, value: "Let me look." });
	});

	it("lets the tool run while the line is still being spoken, and the speech not wait for the tool", async () => {
		const queue = new ParlumeSentenceQueue(800);
		let finishPlayback = () => {};
		const playbackDone = new Promise<void>((resolve) => {
			finishPlayback = resolve;
		});
		let playbackFinished = false;
		const spoken: string[] = [];
		const speaker = (async () => {
			for await (const sentence of queue) {
				spoken.push(sentence);
				await playbackDone;
				playbackFinished = true;
			}
		})();
		let startedDuringSpeech = false;
		let toolFinished = false;
		const tool = {
			inputSchema: {},
			execute: vi.fn(async () => {
				startedDuringSpeech = !playbackFinished;
				await Promise.resolve();
				toolFinished = true;
				return { storyId: "story-1" };
			}),
		};

		const result = await withAgentToolRuntime(
			{
				invoke: (invocation) => invocation.execute(),
				onToolStart: createToolNarrator(queue),
			},
			async () => {
				const tools: Record<string, unknown> = {
					fabric_create_story: tool,
				};
				await prepareAgentTools(tools);
				return (
					tools.fabric_create_story as {
						execute: (args: unknown) => Promise<unknown>;
					}
				).execute({ title: "Parlume test" });
			},
		);

		expect(result).toEqual({ storyId: "story-1" });
		expect(startedDuringSpeech).toBe(true);
		expect(toolFinished).toBe(true);
		expect(playbackFinished).toBe(false);
		expect(spoken).toEqual(["Creating that now."]);
		finishPlayback();
		queue.end();
		await speaker;
		expect(playbackFinished).toBe(true);
	});
});
