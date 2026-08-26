import { describe, expect, it } from "vitest";
import { humanizeToolCall, deriveTrajectorySteps } from "../derive-trajectory";
import type { DirectStreamMessage } from "../../hooks/useDirectStream";

describe("humanizeToolCall", () => {
	it("turns a search tool name + query arg into a sentence", () => {
		const step = humanizeToolCall({
			id: "tc_1",
			name: "search_codebase",
			args: { query: "auth middleware" },
			status: "complete",
		});

		expect(step.title).toBe("Searched codebase for “auth middleware”");
		expect(step.type).toBe("tool_call");
		expect(step.status).toBe("success");
		expect(step.metadata?.toolName).toBe("search_codebase");
	});

	it("falls back to a generic title when the tool name is unknown", () => {
		const step = humanizeToolCall({
			id: "tc_2",
			name: "weird_custom_tool",
			args: {},
			status: "complete",
		});

		expect(step.title).toBe("Called weird_custom_tool");
	});

	it("marks errored tool calls as error steps with reason", () => {
		const step = humanizeToolCall({
			id: "tc_3",
			name: "fetch_url",
			args: { url: "https://x.example" },
			status: "error",
			result: "permission denied",
		});

		expect(step.type).toBe("error");
		expect(step.status).toBe("error");
		expect(step.metadata?.error).toBe("permission denied");
	});

	it("marks pending/running tool calls as running", () => {
		for (const status of ["pending", "running"] as const) {
			const step = humanizeToolCall({
				id: "tc_4",
				name: "search_codebase",
				args: { query: "x" },
				status,
			});
			expect(step.status).toBe("running");
		}
	});

	describe("Fabric platform tool templates", () => {
		// Pinned for F-1171 — the floating Fabric Agent encounters these tools
		// far more often than the generic / third-party names above. Without
		// templates, the trace shows "Called fabric_xxx" which is uninformative
		// and was the most visible UX issue during in-app QA.
		it.each([
			[
				"load_skill",
				{ slug: "mention-users" },
				"Loaded skill mention-users",
			],
			[
				"fabric_query_workspace",
				{ workspaceId: "w1", query: "auth flow" },
				"Queried workspace for “auth flow”",
			],
			["fabric_get_identity", {}, "Checked identity"],
			["fabric_list_projects", {}, "Listed projects"],
			["fabric_get_project", { projectId: "p1" }, "Read project"],
			["fabric_list_features", { projectId: "p1" }, "Listed features"],
			[
				"fabric_get_feature",
				{ featureId: "f1", projectId: "p1" },
				"Read feature details",
			],
			["fabric_list_documents", { projectId: "p1" }, "Listed documents"],
			["fabric_get_document", { documentId: "d1" }, "Read document"],
			["fabric_list_workflows", {}, "Listed workflows"],
		])("%s renders as %s", (name, args, expected) => {
			const step = humanizeToolCall({
				id: "tc",
				name,
				args,
				status: "complete",
			});
			expect(step.title).toBe(expected);
			expect(step.type).toBe("tool_call");
			expect(step.status).toBe("success");
			expect(step.metadata?.toolName).toBe(name);
		});
	});

	describe("Fabric read-tool titles enrich with result identity", () => {
		// Regression for the case where the AI fetches multiple documents /
		// features / projects in one assistant turn. Without result-aware
		// titles the collapsed Reasoning Trace shows several indistinguishable
		// "Read document" rows and the user cannot tell which sources were
		// actually consulted without expanding each step. The gateway results
		// expose human-readable fields (project.name, feature.identifier +
		// title, document.title + type) — those are surfaced in the title.
		it("renders fabric_get_project with the project name when result is available", () => {
			const step = humanizeToolCall({
				id: "tc",
				name: "fabric_get_project",
				args: { projectId: "p1" },
				status: "complete",
				result: { id: "p1", name: "Fabric Loom", status: "ACTIVE" },
			});
			expect(step.title).toBe("Read project “Fabric Loom”");
		});

		it("renders fabric_get_feature with identifier and title", () => {
			const step = humanizeToolCall({
				id: "tc",
				name: "fabric_get_feature",
				args: { featureId: "f1", projectId: "p1" },
				status: "complete",
				result: { id: "f1", identifier: "F-001", title: "Login flow" },
			});
			expect(step.title).toBe("Read feature F-001 “Login flow”");
		});

		it("renders fabric_get_feature with identifier alone when title is missing", () => {
			const step = humanizeToolCall({
				id: "tc",
				name: "fabric_get_feature",
				args: { featureId: "f1", projectId: "p1" },
				status: "complete",
				result: { id: "f1", identifier: "F-002" },
			});
			expect(step.title).toBe("Read feature F-002");
		});

		it("renders fabric_get_document with type and title (PRD, spec, etc.)", () => {
			const step = humanizeToolCall({
				id: "tc",
				name: "fabric_get_document",
				args: { documentId: "d1" },
				status: "complete",
				result: { id: "d1", title: "Auth Architecture", type: "PRD" },
			});
			expect(step.title).toBe("Read PRD “Auth Architecture”");
		});

		it("renders fabric_get_document with just title when type is missing", () => {
			const step = humanizeToolCall({
				id: "tc",
				name: "fabric_get_document",
				args: { documentId: "d1" },
				status: "complete",
				result: { id: "d1", title: "Notes" },
			});
			expect(step.title).toBe("Read document “Notes”");
		});

		it("falls back to generic title while the tool call is still running (no result)", () => {
			const step = humanizeToolCall({
				id: "tc",
				name: "fabric_get_document",
				args: { documentId: "d1" },
				status: "running",
			});
			expect(step.title).toBe("Read document");
		});

		it("multiple document reads in one turn render as distinguishable rows", () => {
			// The original Codex finding: derive-trajectory pre-fix produced
			// three identical "Read document" rows for this scenario. Pin the
			// distinguishability contract.
			const callA = humanizeToolCall({
				id: "a",
				name: "fabric_get_document",
				args: { documentId: "doc-a" },
				status: "complete",
				result: { id: "doc-a", title: "PRD", type: "PRD" },
			});
			const callB = humanizeToolCall({
				id: "b",
				name: "fabric_get_document",
				args: { documentId: "doc-b" },
				status: "complete",
				result: {
					id: "doc-b",
					title: "Auth Spec",
					type: "TECHNICAL_SPEC",
				},
			});
			const callC = humanizeToolCall({
				id: "c",
				name: "fabric_get_document",
				args: { documentId: "doc-c" },
				status: "complete",
				result: { id: "doc-c", title: "API Reference" },
			});

			const titles = new Set([callA.title, callB.title, callC.title]);
			expect(titles.size).toBe(3);
			expect(callA.title).toBe("Read PRD “PRD”");
			expect(callB.title).toBe("Read TECHNICAL_SPEC “Auth Spec”");
			expect(callC.title).toBe("Read document “API Reference”");
		});
	});
});

describe("deriveTrajectorySteps", () => {
	const baseMessage: Omit<DirectStreamMessage, "toolCalls"> = {
		id: "m1",
		role: "assistant",
		content: "Done.",
		timestamp: new Date("2026-05-13T10:00:00Z"),
	};

	it("returns empty array for messages without tool calls", () => {
		expect(
			deriveTrajectorySteps({ ...baseMessage, toolCalls: [] }),
		).toEqual([]);
	});

	it("returns one step per tool call, preserving order", () => {
		const steps = deriveTrajectorySteps({
			...baseMessage,
			toolCalls: [
				{
					id: "a",
					name: "search_codebase",
					args: { query: "x" },
					status: "complete",
				},
				{
					id: "b",
					name: "list_tickets",
					args: { query: "y" },
					status: "complete",
				},
			],
		});

		expect(steps.map((s) => s.id)).toEqual(["a", "b"]);
		expect(steps[0].title).toContain("Searched codebase");
		expect(steps[1].title).toContain("Listed tickets");
	});

	it("appends a final reflection step when the assistant message is complete", () => {
		const steps = deriveTrajectorySteps({
			...baseMessage,
			content: "I found 3 related tickets.",
			isStreaming: false,
			toolCalls: [
				{
					id: "a",
					name: "list_tickets",
					args: { query: "y" },
					status: "complete",
				},
			],
		});

		expect(steps.at(-1)?.type).toBe("reflection");
		expect(steps.at(-1)?.title).toBe("Summarized findings");
	});

	it("does not append a reflection step while still streaming", () => {
		const steps = deriveTrajectorySteps({
			...baseMessage,
			content: "Looking…",
			isStreaming: true,
			toolCalls: [
				{
					id: "a",
					name: "search_codebase",
					args: { query: "x" },
					status: "running",
				},
			],
		});

		expect(steps.some((s) => s.type === "reflection")).toBe(false);
	});

	it("does not append a reflection step when isStreaming is undefined", () => {
		const steps = deriveTrajectorySteps({
			...baseMessage,
			// isStreaming intentionally absent — simulates an older persisted message
			toolCalls: [
				{
					id: "a",
					name: "search_codebase",
					args: { query: "x" },
					status: "complete",
				},
			],
		});

		expect(steps.some((s) => s.type === "reflection")).toBe(false);
	});

	it("does not append a reflection step when content is empty after trim", () => {
		const steps = deriveTrajectorySteps({
			...baseMessage,
			content: "   ",
			isStreaming: false,
			toolCalls: [
				{
					id: "a",
					name: "search_codebase",
					args: { query: "x" },
					status: "complete",
				},
			],
		});

		expect(steps.some((s) => s.type === "reflection")).toBe(false);
	});
});
