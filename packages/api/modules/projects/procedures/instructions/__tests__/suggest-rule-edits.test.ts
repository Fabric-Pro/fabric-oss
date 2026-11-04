/**
 * `instructions.suggestRuleEdits`: the AI rules review as concrete file edits.
 * Pinned here: it demands INSTRUCTION_CREATE ahead of the handler (a viewer is
 * refused before any read or model call), acts in the project's own
 * organization whatever the request names, offers only edits to rule files it
 * read and gave the model, handles the model's structured answer and its
 * failure, and writes nothing: no change procedure, storage write or commit
 * is reachable from it. The edits answer the review's findings: each carries
 * the shared categories it addresses (unknown ones dropped), and every file
 * the review flagged is either edited or reported as skipped.
 *
 * The stub `.use()` composes each middleware ahead of the real handler, as in
 * `commit-change.test.ts`, so a rejecting permission middleware really
 * short-circuits the call.
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handler: null as null | ((...a: unknown[]) => Promise<unknown>),
	permissionMiddleware: vi.fn(),
	requestedPermission: undefined as string | undefined,
	hostingOrg: vi.fn(),
	readRules: vi.fn(),
	getModel: vi.fn(),
	generateText: vi.fn(),
	trackUsage: vi.fn(),
	submit: vi.fn(),
}));

vi.mock("../../../../../orpc/middleware/project-visibility", () => ({
	projectNotFoundUnlessVisible: async () => undefined,
}));
vi.mock("../hosting-organization", () => ({
	requireHostingOrganizationId: (...a: unknown[]) => m.hostingOrg(...a),
}));
vi.mock("../rules-health", async () => {
	const actual =
		await vi.importActual<typeof import("../rules-health")>(
			"../rules-health",
		);
	return {
		boundRuleBlocks: actual.boundRuleBlocks,
		readRules: (...a: unknown[]) => m.readRules(...a),
	};
});
// Any write path, so a test can prove none is reached.
vi.mock("../submit-change", () => ({
	submitInstructionChange: (...a: unknown[]) => m.submit(...a),
}));
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: (...a: unknown[]) => m.getModel(...a),
	generateText: (...a: unknown[]) => m.generateText(...a),
	Output: { object: (o: unknown) => ({ kind: "object", ...(o as object) }) },
}));
vi.mock("@repo/ai/lib/structured-output", () => ({
	requireStructuredOutput: async (p: Promise<unknown>) => p,
}));
vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../../../orpc/procedures", () => {
	const middlewares: Array<(args: unknown) => unknown> = [];
	const b = {
		use: (mw: (args: unknown) => unknown) => {
			middlewares.push(mw);
			return b;
		},
		route: () => b,
		input: () => b,
		handler: (fn: (...a: unknown[]) => unknown) => {
			const composed = async (args: unknown) => {
				for (const mw of middlewares) {
					await mw(args);
				}
				return fn(args as never);
			};
			m.handler = composed;
			return composed;
		},
	};
	return {
		tenantProtectedProcedure: b,
		requireProjectPermission: (permission: string) => {
			m.requestedPermission = permission;
			return (args: unknown) => m.permissionMiddleware(args);
		},
		Permissions: {
			INSTRUCTION_READ: "instruction:read",
			INSTRUCTION_CREATE: "instruction:create",
		},
	};
});

import {
	frontmatterParses,
	SUGGESTED_EDITS_SCHEMA,
	validateSuggestedEdits,
} from "../suggest-rule-edits";

const ctx = {
	user: { id: "user_1", email: "dev@example.com", name: "Pat Example" },
	session: { activeOrganizationId: "org_active" },
};

function call(input: Record<string, unknown>) {
	if (!m.handler) {
		throw new Error("the procedure was not built");
	}
	return m.handler({ input, context: ctx });
}

const RULES = [
	{
		path: ".claude/rules/testing.md",
		text: "---\ndescription: Tests\n---\nWrite tests.\nAlways write tests.\n",
	},
	{
		path: ".claude/rules/style.md",
		text: "Keep code clean.\n",
	},
];

function modelAnswers(edits: unknown[]) {
	m.generateText.mockResolvedValue({ output: { edits } });
}

beforeEach(() => {
	m.permissionMiddleware.mockReset();
	m.permissionMiddleware.mockResolvedValue(undefined);
	m.hostingOrg.mockReset();
	m.hostingOrg.mockResolvedValue("org_host");
	m.readRules.mockReset();
	m.readRules.mockResolvedValue({
		source: "published",
		rules: RULES,
		base: { baseSnapshotId: "snap_pub" },
	});
	m.trackUsage.mockReset();
	m.getModel.mockReset();
	m.getModel.mockResolvedValue({ model: "model", trackUsage: m.trackUsage });
	m.generateText.mockReset();
	m.submit.mockReset();
});

describe("instructions.suggestRuleEdits", () => {
	it("requires INSTRUCTION_CREATE, the permission an edit needs", () => {
		expect(m.requestedPermission).toBe("instruction:create");
	});

	it("refuses a viewer before reading rules or calling the model", async () => {
		m.permissionMiddleware.mockRejectedValueOnce(
			new ORPCError("FORBIDDEN", { message: "no" }),
		);

		await expect(call({ projectId: "proj_1" })).rejects.toThrow("no");

		expect(m.readRules).not.toHaveBeenCalled();
		expect(m.getModel).not.toHaveBeenCalled();
	});

	it("acts in the project's organization, never the one the request names", async () => {
		modelAnswers([]);

		await call({ projectId: "proj_1", organizationId: "org_other" });

		expect(m.hostingOrg).toHaveBeenCalledWith("proj_1", "user_1");
		expect(m.readRules).toHaveBeenCalledWith(
			"proj_1",
			"user_1",
			"org_host",
		);
		expect(m.getModel).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				organizationId: "org_host",
				projectId: "proj_1",
				userId: "user_1",
			}),
		);
	});

	it("asks for structured output with the schema and passes the review's findings and files", async () => {
		modelAnswers([]);

		await call({
			projectId: "proj_1",
			findings: [
				{
					category: "overlap",
					files: [".claude/rules/testing.md"],
					summary: "merge\nthem",
				},
			],
		});

		const request = m.generateText.mock.calls[0]?.[0] as {
			output: { schema: unknown };
			prompt: string;
		};
		expect(request.output.schema).toBe(SUGGESTED_EDITS_SCHEMA);
		expect(request.prompt).toContain(
			"- overlap: merge them (.claude/rules/testing.md)",
		);
		expect(request.prompt).toContain("### .claude/rules/testing.md");
		expect(m.trackUsage).toHaveBeenCalledOnce();
	});

	it("returns the edits with their before text and the base the rules were read from, writing nothing", async () => {
		modelAnswers([
			{
				path: ".claude/rules/testing.md",
				action: "update",
				content:
					'---\ndescription: Tests\npaths:\n  - "**/*.test.ts"\n---\nWrite a test for every change.\n',
				reason: "Merge the repeated rule and scope it to tests",
				categories: ["overlap", "narrower-scope"],
			},
			{
				path: ".claude/rules/style.md",
				action: "delete",
				content: null,
				reason: "Too vague to act on",
				categories: ["vague"],
			},
		]);

		const result = (await call({ projectId: "proj_1" })) as {
			base: unknown;
			edits: Array<Record<string, unknown>>;
			skipped: unknown[];
		};

		expect(result.base).toEqual({ baseSnapshotId: "snap_pub" });
		expect(result.edits).toEqual([
			{
				path: ".claude/rules/testing.md",
				before: RULES[0]?.text,
				after: expect.stringContaining(
					"Write a test for every change.",
				),
				action: "update",
				reason: "Merge the repeated rule and scope it to tests",
				categories: ["overlap", "narrower-scope"],
			},
			{
				path: ".claude/rules/style.md",
				before: RULES[1]?.text,
				after: "",
				action: "delete",
				reason: "Too vague to act on",
				categories: ["vague"],
			},
		]);
		expect(result.skipped).toEqual([]);
		expect(m.submit).not.toHaveBeenCalled();
	});

	it("rejects paths outside the rules that were read", async () => {
		modelAnswers([
			{
				path: "CLAUDE.md",
				action: "update",
				content: "x\n",
				reason: "r",
				categories: [],
			},
			{
				path: "../.claude/rules/testing.md",
				action: "delete",
				content: null,
				reason: "r",
				categories: [],
			},
			{
				path: ".claude/rules/new.md",
				action: "update",
				content: "new\n",
				reason: "r",
				categories: [],
			},
		]);

		const result = (await call({ projectId: "proj_1" })) as {
			edits: unknown[];
			skipped: Array<{ path: string; why: string }>;
		};

		expect(result.edits).toEqual([]);
		expect(result.skipped.map((s) => s.why)).toEqual([
			"unknown-path",
			"unknown-path",
			"unknown-path",
		]);
	});

	it("answers SERVICE_UNAVAILABLE when the model gives no usable object", async () => {
		m.generateText.mockResolvedValue({ output: { edits: "not a list" } });

		await expect(call({ projectId: "proj_1" })).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
		});
		expect(m.submit).not.toHaveBeenCalled();
	});

	it("answers SERVICE_UNAVAILABLE when the model call fails", async () => {
		m.generateText.mockRejectedValue(new Error("provider down"));

		await expect(call({ projectId: "proj_1" })).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
		});
	});

	it("returns no edits, without a model call, when there are no rules", async () => {
		m.readRules.mockResolvedValue({
			source: "none",
			rules: [],
			base: null,
		});

		await expect(call({ projectId: "proj_1" })).resolves.toEqual({
			base: null,
			edits: [],
			skipped: [],
		});
		expect(m.getModel).not.toHaveBeenCalled();
	});
});

describe("validateSuggestedEdits", () => {
	const given = RULES;

	it("drops an edit whose new content carries a secret", () => {
		const { edits, skipped } = validateSuggestedEdits(
			[
				{
					path: ".claude/rules/style.md",
					action: "update",
					content: "Use AKIAIOSFODNN7EXAMPLE for the bucket.\n",
					reason: "r",
					categories: [],
				},
			],
			given,
		);

		expect(edits).toEqual([]);
		expect(skipped).toEqual([
			{ path: ".claude/rules/style.md", categories: [], why: "secret" },
		]);
	});

	it("drops an update whose frontmatter does not parse, or that changes nothing", () => {
		const { edits, skipped } = validateSuggestedEdits(
			[
				{
					path: ".claude/rules/testing.md",
					action: "update",
					content: "---\ndescription: never closed\nWrite tests.\n",
					reason: "r",
					categories: [],
				},
				{
					path: ".claude/rules/style.md",
					action: "update",
					content: RULES[1]?.text ?? "",
					reason: "r",
					categories: [],
				},
			],
			given,
		);

		expect(edits).toEqual([]);
		expect(skipped.map((s) => s.why)).toEqual(["frontmatter", "unchanged"]);
	});

	it("keeps the first edit of a path and drops repeats", () => {
		const { edits, skipped } = validateSuggestedEdits(
			[
				{
					path: ".claude/rules/style.md",
					action: "update",
					content: "Name things for what they do.\n",
					reason: "r",
					categories: [],
				},
				{
					path: ".claude/rules/style.md",
					action: "delete",
					content: null,
					reason: "r",
					categories: [],
				},
			],
			given,
		);

		expect(edits).toHaveLength(1);
		expect(skipped).toEqual([
			{
				path: ".claude/rules/style.md",
				categories: [],
				why: "duplicate",
			},
		]);
	});

	const FINDINGS = [
		{
			category: "overlap" as const,
			files: [".claude/rules/testing.md", ".claude/rules/style.md"],
			summary: "Merge them",
		},
		{
			category: "vague" as const,
			files: [".claude/rules/style.md"],
			summary: "Say what clean means",
		},
	];

	it("keeps the known categories an edit names, and falls back to the file's findings when none is left", () => {
		const { edits } = validateSuggestedEdits(
			[
				{
					path: ".claude/rules/testing.md",
					action: "update",
					content: "Write a test for every change.\n",
					reason: "r",
					categories: ["made-up", "overlap", "overlap"],
				},
				{
					path: ".claude/rules/style.md",
					action: "update",
					content: "Name things for what they do.\n",
					reason: "r",
					categories: ["contradiction"],
				},
			],
			given,
			FINDINGS,
		);

		expect(edits.map((edit) => [edit.path, edit.categories])).toEqual([
			[".claude/rules/testing.md", ["overlap"]],
			[".claude/rules/style.md", ["overlap", "vague"]],
		]);
	});

	it("leaves out an edit of a file the review did not flag", () => {
		const { edits, skipped } = validateSuggestedEdits(
			[
				{
					path: ".claude/rules/style.md",
					action: "update",
					content: "Name things for what they do.\n",
					reason: "r",
					categories: ["vague"],
				},
			],
			given,
			[
				{
					category: "vague",
					files: [".claude/rules/testing.md"],
					summary: "s",
				},
			],
		);

		expect(edits).toEqual([]);
		expect(skipped).toEqual([
			{
				path: ".claude/rules/style.md",
				categories: [],
				why: "not-flagged",
			},
			{
				path: ".claude/rules/testing.md",
				categories: ["vague"],
				why: "not-changed",
			},
		]);
	});

	it("reports every flagged file without an edit, with its categories, so none disappears", () => {
		const { edits, skipped } = validateSuggestedEdits(
			[
				{
					path: ".claude/rules/testing.md",
					action: "update",
					content: "Write a test for every change.\n",
					reason: "r",
					categories: ["overlap"],
				},
			],
			given,
			FINDINGS,
		);

		expect(edits.map((edit) => edit.path)).toEqual([
			".claude/rules/testing.md",
		]);
		expect(skipped).toEqual([
			{
				path: ".claude/rules/style.md",
				categories: ["overlap", "vague"],
				why: "not-changed",
			},
		]);
	});

	it("keeps a flagged file's failed edit as its reason, not as a second entry", () => {
		const { skipped } = validateSuggestedEdits(
			[
				{
					path: ".claude/rules/style.md",
					action: "update",
					content: "Use AKIAIOSFODNN7EXAMPLE for the bucket.\n",
					reason: "r",
					categories: ["vague"],
				},
			],
			given,
			FINDINGS,
		);

		expect(skipped).toEqual([
			{
				path: ".claude/rules/style.md",
				categories: ["overlap", "vague"],
				why: "secret",
			},
			{
				path: ".claude/rules/testing.md",
				categories: ["overlap"],
				why: "not-changed",
			},
		]);
	});
});

describe("frontmatterParses", () => {
	it("accepts a file without frontmatter and closed blocks of keys", () => {
		expect(frontmatterParses("Just text\n")).toBe(true);
		expect(
			frontmatterParses(
				'---\ndescription: x\npaths:\n  - "src/**"\nload: on-demand\n---\nBody\n',
			),
		).toBe(true);
	});

	it("refuses an unclosed block and a line that is not a key", () => {
		expect(frontmatterParses("---\ndescription: x\nBody\n")).toBe(false);
		expect(frontmatterParses("---\nnot a key\n---\nBody\n")).toBe(false);
	});
});
