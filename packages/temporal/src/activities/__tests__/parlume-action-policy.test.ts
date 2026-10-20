import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	parlumeActionArguments,
	parlumeActionOutcome,
	parlumeFingerprint,
	parlumeToolFingerprint,
	summarizeParlumeAction,
} from "../parlume-action-policy";

describe("Parlume action outcomes", () => {
	it("counts the result of a created work item as completed", () => {
		expect(
			parlumeActionOutcome({
				storyId: "story-1",
				identifier: "251",
				title: "Parlume test",
				kind: "FEATURE",
				url: "https://fabric.example/app/example-org/projects/p/stories/story-1",
				aiDrafted: true,
			}),
		).toBe("COMPLETED");
	});
	it("counts a work item created for later drafting as completed", () => {
		expect(
			parlumeActionOutcome({
				storyId: "story-1",
				identifier: "251",
				aiDrafted: false,
				draftingInBackground: true,
			}),
		).toBe("COMPLETED");
	});
	it("still reads an explicit success flag or completed status", () => {
		expect(parlumeActionOutcome({ success: true })).toBe("COMPLETED");
		expect(parlumeActionOutcome({ status: "completed" })).toBe("COMPLETED");
	});
	it.each([
		["an error", { error: "Permission denied" }],
		["a failure flag", { success: false }],
		["a tool error", { isError: true, content: [] }],
	])("fails on %s", (_name, result) => {
		expect(parlumeActionOutcome(result)).toBe("FAILED");
	});
	it("does not count an error that carries an id as completed", () => {
		expect(
			parlumeActionOutcome({ error: "Failed to create", storyId: "s" }),
		).toBe("FAILED");
	});
	it.each([
		["a queued job", { id: "job-1", status: "queued" }],
		["a timeout", { error: "The request timed out" }],
		["a timeout reported as a message", { message: "Connection lost" }],
		["a result with nothing to confirm", { note: "ok" }],
		["a bare string", "done"],
	])("leaves %s unverified or failed, never completed", (_name, result) => {
		expect(parlumeActionOutcome(result)).not.toBe("COMPLETED");
	});
	it("does not read the words of a created item as a failure", () => {
		expect(
			parlumeActionOutcome({
				storyId: "story-1",
				identifier: "252",
				title: "Fix the request timeout when the connection closed",
			}),
		).toBe("COMPLETED");
	});
});

describe("Parlume action policy", () => {
	it("binds a call to payload content, independent of object key order", () => {
		expect(parlumeFingerprint({ a: 1, b: { c: 2 } })).toBe(
			parlumeFingerprint({ b: { c: 2 }, a: 1 }),
		);
		expect(parlumeFingerprint({ title: "First" })).not.toBe(
			parlumeFingerprint({ title: "Second" }),
		);
	});
	it("identifies a changed tool schema", () => {
		expect(
			parlumeToolFingerprint({
				name: "create_issue",
				inputSchema: z.object({ title: z.string() }),
			}),
		).not.toBe(
			parlumeToolFingerprint({
				name: "create_issue",
				inputSchema: z.object({ title: z.string().min(5) }),
			}),
		);
	});
	it("binds only stable source identity when loader metadata is present", () => {
		const definition = {
			name: "connection_create_issue",
			inputSchema: z.object({ title: z.string() }),
		};
		const source = {
			configId: "connection",
			originalName: "create_issue",
			serverName: "Issue provider",
		};
		expect(parlumeToolFingerprint({ ...definition, source })).toBe(
			parlumeToolFingerprint({
				...definition,
				source: {
					configId: source.configId,
					originalName: source.originalName,
				},
			}),
		);
	});
	it("rejects secret-bearing arguments without modifying executable payloads", () => {
		expect(() =>
			parlumeActionArguments({ nested: { apiKey: "example" } }),
		).toThrow("credentials");
		expect(
			parlumeActionArguments({
				title: "A synthetic issue",
				assigned: "example-user",
			}),
		).toEqual({ title: "A synthetic issue", assigned: "example-user" });
	});
	it("summarizes an action for the history without asking anyone to confirm it", () => {
		const summary = summarizeParlumeAction("fabric_create_story", {
			title: "Parlume test",
		});

		expect(summary).toBe("Create story. title: Parlume test");
		expect(summary).not.toMatch(/confirm|cancel/i);
	});
});
