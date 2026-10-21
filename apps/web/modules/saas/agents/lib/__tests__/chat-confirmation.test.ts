import { describe, expect, it } from "vitest";
import {
	approvalMessage,
	approveLabel,
	type ChatConfirmationRequest,
	confirmationDescription,
	confirmationTitle,
	describeConsequence,
	describeToolAction,
	describeToolPhrase,
	hasBlockingProblems,
	readConfirmationRequest,
	summarizeArguments,
} from "../chat-confirmation";

const DRAFT = {
	kind: "workflow",
	name: "Weekly digest",
	description: null,
	schedule: {
		cron: "0 9 * * 1",
		timezone: "UTC",
		description: "every Monday at 09:00 (UTC)",
	},
	prompt: "p",
	mcpServers: [],
	builtInTools: [],
	project: null,
	outputTitle: "t",
	outputFormat: "html",
	steps: [],
	problems: [],
};

/** A request for `toolName` as the chat holds it, with the parts a test sets. */
function request(
	toolName: string,
	rest: Partial<ChatConfirmationRequest> = {},
): ChatConfirmationRequest {
	return { toolName, args: {}, ...rest };
}

function read(result: Record<string, unknown>): ChatConfirmationRequest {
	const parsed = readConfirmationRequest({
		requiresConfirmation: true,
		args: {},
		...result,
	});
	if (!parsed) {
		throw new Error("expected a confirmation request");
	}
	return parsed;
}

describe("readConfirmationRequest", () => {
	it("reads the tool, its exact arguments and a workflow draft", () => {
		const parsed = readConfirmationRequest({
			requiresConfirmation: true,
			toolName: "fabric_create_workflow",
			args: { preset: { name: "Weekly digest" } },
			draft: DRAFT,
		});

		expect(parsed).toMatchObject({
			toolName: "fabric_create_workflow",
			args: { preset: { name: "Weekly digest" } },
			workflowDraft: { name: "Weekly digest" },
		});
		expect(parsed?.workflowAction).toBeUndefined();
	});

	it("reads a workflow action draft", () => {
		const parsed = readConfirmationRequest({
			requiresConfirmation: true,
			toolName: "fabric_execute_workflow",
			args: { workflowId: "wf-1" },
			draft: {
				kind: "workflow-action",
				workflowId: "wf-1",
				workflowName: "Nightly digest",
			},
		});

		expect(parsed?.workflowAction?.workflowName).toBe("Nightly digest");
	});

	it("keeps the request but shows no workflow card for a draft it does not understand", () => {
		const parsed = readConfirmationRequest({
			requiresConfirmation: true,
			toolName: "fabric_create_workflow",
			args: {},
			draft: { kind: "workflow", name: 3 },
		});

		expect(parsed).not.toBeNull();
		expect(parsed?.workflowDraft).toBeUndefined();
	});

	it.each([
		null,
		"text",
		{ workflows: [] },
		{ requiresConfirmation: false },
		{ requiresConfirmation: "yes" },
		// Approving runs the call the request names and nothing else, so a
		// request that names no tool or no arguments has nothing to approve.
		{ requiresConfirmation: true },
		{ requiresConfirmation: true, toolName: "fabric_share_page" },
		{ requiresConfirmation: true, args: {} },
		{
			requiresConfirmation: true,
			workflowId: "wf-1",
			workflowName: "Nightly digest",
		},
	])("reads nothing from %j", (result) => {
		expect(readConfirmationRequest(result)).toBeNull();
	});
});

describe("the words around a request", () => {
	it("names the workflow tools' actions and spells out any other tool", () => {
		expect(describeToolAction(request("fabric_execute_workflow"))).toBe(
			"Run workflow",
		);
		expect(describeToolAction(request("fabric_update_workflow"))).toBe(
			"Edit workflow",
		);
		expect(describeToolAction(request("fabric_unpublish_workflow"))).toBe(
			"Unpublish workflow",
		);
		expect(describeToolAction(request("fabric_share_page"))).toBe(
			"Share page",
		);
	});

	it("gives each page tool's action as a phrase that reads in a sentence, with its proper nouns intact", () => {
		expect(describeToolPhrase("fabric_page_ask")).toBe(
			"ask the AI a question",
		);
		expect(describeToolPhrase("fabric_page_read_connected")).toBe(
			"read from your connected account",
		);
		expect(describeToolPhrase("fabric_page_file_upload")).toBe(
			"upload a file to this page",
		);
		expect(describeToolPhrase("fabric_page_run_workflow")).toBe(
			"run its workflow",
		);
		expect(describeToolPhrase("fabric_share_page")).toBe("share page");
		expect(describeToolPhrase("")).toBe("run action");
	});

	it("keeps the AI capitalised in the transcript and in the title", () => {
		expect(approvalMessage(request("fabric_page_ask"))).toBe(
			"Approved: ask the AI a question.",
		);
		expect(describeToolAction(request("fabric_page_ask"))).toBe(
			"Ask the AI a question",
		);
	});

	it("says in the transcript what was approved", () => {
		expect(
			approvalMessage(
				request("fabric_publish_workflow", {
					workflowAction: {
						kind: "workflow-action",
						workflowId: "wf-1",
						workflowName: "Nightly digest",
					},
				}),
			),
		).toBe("Approved: publish workflow “Nightly digest”.");
		expect(approvalMessage(request("fabric_share_page"))).toBe(
			"Approved: share page.",
		);
	});

	it("promises only what approving does", () => {
		const scheduled = read({
			toolName: "fabric_create_workflow",
			draft: DRAFT,
		});
		const manual = read({
			toolName: "fabric_create_workflow",
			draft: { ...DRAFT, schedule: null },
		});

		expect(describeConsequence(scheduled)).toContain("runs it once now");
		expect(describeConsequence(manual)).toBe(
			"Approving creates the workflow as a draft.",
		);
		expect(describeConsequence(request("fabric_share_page"))).toBe(
			"Approving runs this action once.",
		);
	});

	it.each([
		["fabric_unpublish_workflow", "reverts the workflow to a draft"],
		["fabric_pause_workflow", "pauses the workflow's schedule"],
		["fabric_resume_workflow", "resumes the workflow's schedule"],
	])("says what %s does", (toolName, consequence) => {
		expect(describeConsequence(request(toolName))).toContain(consequence);
	});

	it("names the tools a page is given, because the person approves them for whoever opens it", () => {
		const consequence = describeConsequence(
			request("fabric_create_frame", {
				args: {
					title: "Status",
					runtimeTools: [
						"fabric_list_workflows",
						"fabric_get_frame",
						7,
					],
				},
			}),
		);

		expect(consequence).toContain(
			"fabric_list_workflows, fabric_get_frame",
		);
		expect(consequence).toContain("whoever opens it");
		expect(consequence).not.toContain("7");
	});

	it("says nothing about page tools for a page that is given none", () => {
		for (const args of [{}, { runtimeTools: [] }, { runtimeTools: "x" }]) {
			expect(
				describeConsequence(request("fabric_update_frame", { args })),
			).toBe("Approving runs this action once.");
		}
	});
});

describe("the one confirmation card", () => {
	const draftRequest = read({
		toolName: "fabric_create_workflow",
		draft: { ...DRAFT, description: "Posts every Monday" },
	});

	it("titles itself with the action and what it acts on, and describes from the draft", () => {
		expect(confirmationTitle(draftRequest)).toBe(
			"Create workflow: Weekly digest",
		);
		expect(confirmationDescription(draftRequest)).toBe(
			"Posts every Monday",
		);
		expect(confirmationTitle(request("fabric_share_page"))).toBe(
			"Share page",
		);
	});

	it("keeps Execute for starting a run and says Approve for the rest", () => {
		expect(approveLabel(request("fabric_execute_workflow"))).toBe(
			"Execute",
		);
		expect(approveLabel(request("fabric_create_workflow"))).toBe("Approve");
	});

	it("blocks approval only while the draft has problems", () => {
		const blocked = read({
			toolName: "fabric_create_workflow",
			draft: { ...DRAFT, problems: ["too frequent"] },
		});

		expect(hasBlockingProblems(blocked)).toBe(true);
		expect(hasBlockingProblems(draftRequest)).toBe(false);
		expect(hasBlockingProblems(request("fabric_share_page"))).toBe(false);
	});

	describe("summarizeArguments", () => {
		it("lists plain values one to a row, in order, trimmed", () => {
			const rows = summarizeArguments({
				a: "x".repeat(300),
				b: 2,
				c: true,
				d: "two\nlines  here",
			});

			expect(rows.map(([name]) => name)).toEqual(["a", "b", "c", "d"]);
			expect(rows[0][1]).toHaveLength(120);
			expect(rows[0][1].endsWith("…")).toBe(true);
			expect(rows[1]).toEqual(["b", "2"]);
			expect(rows[3]).toEqual(["d", "two lines here"]);
			expect(summarizeArguments(undefined)).toEqual([]);
		});

		it("shows nested values under their path, so nothing a call carries is out of sight", () => {
			const rows = summarizeArguments({
				name: "Weekly digest",
				preset: {
					schedule: { cron: "0 9 * * 1", timezone: "UTC" },
					prompt: "Summarise the open items",
					mcpServers: ["tracker", "wiki"],
					builtInToolNames: [],
				},
				nodes: [
					{ type: "agent-task", label: "Agent Task" },
					{ type: "publish-frame" },
				],
			});

			expect(rows).toEqual([
				["name", "Weekly digest"],
				["preset.schedule.cron", "0 9 * * 1"],
				["preset.schedule.timezone", "UTC"],
				["preset.prompt", "Summarise the open items"],
				["preset.mcpServers", "tracker, wiki"],
				["nodes[0].type", "agent-task"],
				["nodes[0].label", "Agent Task"],
				["nodes[1].type", "publish-frame"],
			]);
		});

		it("leaves out null, undefined and empty values", () => {
			expect(
				summarizeArguments({
					a: null,
					b: undefined,
					c: {},
					d: [],
					e: { f: null },
					g: "kept",
				}),
			).toEqual([["g", "kept"]]);
		});

		it("stops nesting at a bounded depth, saying how much lies below", () => {
			const rows = summarizeArguments({
				a: { b: { c: { d: { e: 1, f: 2 }, g: [{ h: 1 }, { h: 2 }] } } },
			});

			expect(rows).toEqual([
				["a.b.c.d", "2 fields"],
				["a.b.c.g", "2 items"],
			]);
		});

		it("cuts a long list of plain values short and says how many there are", () => {
			const [row] = summarizeArguments({
				ids: Array.from({ length: 40 }, (_, index) => index),
			});

			expect(row[0]).toBe("ids");
			expect(row[1]).toContain("(40 in all)");
			expect(row[1].split(",").length).toBeLessThan(20);
		});

		it("stops at a bounded number of rows and counts what it left out", () => {
			const args = Object.fromEntries(
				Array.from({ length: 30 }, (_, index) => [`k${index}`, index]),
			);

			const rows = summarizeArguments(args);

			expect(rows).toHaveLength(17);
			expect(rows[15]).toEqual(["k15", "15"]);
			expect(rows[16]).toEqual(["…", "14 more values"]);
		});

		it("says 'value' for a single one left out", () => {
			const args = Object.fromEntries(
				Array.from({ length: 17 }, (_, index) => [`k${index}`, index]),
			);

			expect(summarizeArguments(args).at(-1)).toEqual([
				"…",
				"1 more value",
			]);
		});

		it("counts the values below a row limit that nesting reaches, not the objects", () => {
			const rows = summarizeArguments({
				nodes: Array.from({ length: 10 }, (_, index) => ({
					type: `t${index}`,
					label: `l${index}`,
				})),
			});

			expect(rows).toHaveLength(17);
			expect(rows[16]).toEqual(["…", "4 more values"]);
		});
	});
});
