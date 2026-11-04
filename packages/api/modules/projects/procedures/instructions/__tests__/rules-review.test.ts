/**
 * `instructions.reviewRules`: the AI rules review as structured findings in
 * the shared categories. Pinned here: it asks for structured output, returns
 * the checks' own findings (`over-budget`, `cleanup`) ahead of the model's,
 * keeps only the model's known categories and files it was given, and fails
 * as SERVICE_UNAVAILABLE without leaking the provider's error.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handlers: [] as Array<(...a: unknown[]) => Promise<unknown>>,
	listFiles: vi.fn(),
	readFiles: vi.fn(),
	getModel: vi.fn(),
	generateText: vi.fn(),
	trackUsage: vi.fn(),
}));

vi.mock("../../../../../orpc/middleware/project-visibility", () => ({
	projectNotFoundUnlessVisible: async () => undefined,
}));
vi.mock("../hosting-organization", () => ({
	requireHostingOrganizationId: async () => "org_host",
}));
vi.mock("../repository/direct-query", () => ({
	listDirectRepositoryFilesForApi: (...a: unknown[]) => m.listFiles(...a),
}));
vi.mock("../repository/direct-batch", () => ({
	readDirectRepositoryFilesForApi: (...a: unknown[]) => m.readFiles(...a),
}));
vi.mock("@repo/database", () => ({
	getPublishedInstructionSnapshot: async () => null,
	listInstructionFiles: async () => [],
}));
vi.mock("@repo/storage", () => ({ getStorageProvider: () => ({}) }));
vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { skills: "skills" } } },
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
	const b = {
		use: () => b,
		route: () => b,
		input: () => b,
		handler: (fn: (...a: unknown[]) => Promise<unknown>) => {
			m.handlers.push(fn);
			return fn;
		},
	};
	return {
		tenantProtectedProcedure: b,
		requireProjectPermission: () => async () => undefined,
		Permissions: { INSTRUCTION_READ: "instruction:read" },
	};
});

import { RULES_REVIEW_SCHEMA, reviewRulesProcedure } from "../rules-health";

const ctx = { user: { id: "user_1" }, session: {} };

function review(input: Record<string, unknown>) {
	const handler = reviewRulesProcedure as unknown as (
		args: unknown,
	) => Promise<{ findings: unknown[] }>;
	return handler({ input, context: ctx });
}

const RULES = [
	{ path: ".claude/rules/a.md", text: "Write tests.\n" },
	{ path: ".claude/rules/b.md", text: "Write tests.\n" },
];

beforeEach(() => {
	m.listFiles.mockReset();
	m.listFiles.mockResolvedValue({
		generation: 1,
		commitSha: "a".repeat(40),
		files: RULES.map((rule) => ({ path: rule.path })),
	});
	m.readFiles.mockReset();
	m.readFiles.mockResolvedValue({
		files: RULES.map((rule) => ({
			path: rule.path,
			read: { state: "found", text: rule.text },
		})),
		nextIndex: null,
	});
	m.trackUsage.mockReset();
	m.getModel.mockReset();
	m.getModel.mockResolvedValue({ model: "model", trackUsage: m.trackUsage });
	m.generateText.mockReset();
});

describe("instructions.reviewRules", () => {
	it("asks for structured findings and returns the checks' findings ahead of the model's known ones", async () => {
		m.generateText.mockResolvedValue({
			output: {
				findings: [
					{
						category: "overlap",
						files: [".claude/rules/a.md", ".claude/rules/b.md"],
						summary: "Merge them into one rule.",
					},
					{
						category: "contradiction",
						files: [".claude/rules/a.md"],
						summary: "Not a shared category.",
					},
					{
						category: "vague",
						files: ["CLAUDE.md"],
						summary: "Not a rule file that was read.",
					},
				],
			},
		});

		const result = await review({ projectId: "proj_1" });

		const request = m.generateText.mock.calls[0]?.[0] as {
			output: { schema: unknown };
		};
		expect(request.output.schema).toBe(RULES_REVIEW_SCHEMA);
		expect(result.findings).toEqual([
			{
				category: "cleanup",
				files: [".claude/rules/a.md", ".claude/rules/b.md"],
				summary: "The same rule twice: keep one.",
			},
			{
				category: "overlap",
				files: [".claude/rules/a.md", ".claude/rules/b.md"],
				summary: "Merge them into one rule.",
			},
		]);
		expect(m.trackUsage).toHaveBeenCalledOnce();
	});

	it("answers SERVICE_UNAVAILABLE when the model call fails", async () => {
		m.generateText.mockRejectedValue(new Error("provider down"));

		await expect(review({ projectId: "proj_1" })).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
		});
	});

	it("returns no findings, without a model call, when there are no rules", async () => {
		m.listFiles.mockResolvedValue({
			generation: 1,
			commitSha: "a".repeat(40),
			files: [],
		});

		await expect(review({ projectId: "proj_1" })).resolves.toEqual({
			findings: [],
		});
		expect(m.getModel).not.toHaveBeenCalled();
	});
});
