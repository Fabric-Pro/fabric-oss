import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
	id: string;
	agentId: string;
	name: string;
	displayName: string;
	description: string;
	scope: "SYSTEM" | "ORGANIZATION" | "USER";
	userId: string | null;
	organizationId: string | null;
	status: string;
	config: Record<string, unknown>;
};

const row = (id: string, fields: Partial<Row>): Row => ({
	id,
	agentId: id,
	name: id,
	displayName: id,
	description: "",
	scope: "USER",
	userId: null,
	organizationId: null,
	status: "ACTIVE",
	config: {},
	...fields,
});

const rows: Row[] = [
	row("system-agent", { scope: "SYSTEM" }),
	row("org-agent", { scope: "ORGANIZATION", organizationId: "org-example" }),
	row("other-org-agent", {
		scope: "ORGANIZATION",
		organizationId: "org-other",
	}),
	row("own-agent", {
		userId: "user-example",
		organizationId: "org-example",
	}),
	row("teammate-agent", {
		userId: "user-teammate",
		organizationId: "org-example",
	}),
	row("stranger-personal-agent", { userId: "user-stranger" }),
];

// Prisma treats an undefined value as "no filter", so the evaluator does too.
const matches = (r: Row, where: Record<string, unknown>): boolean =>
	Object.entries(where).every(([key, value]) => {
		if (value === undefined) {
			return true;
		}
		if (key === "OR") {
			return (value as Record<string, unknown>[]).some((arm) =>
				matches(r, arm),
			);
		}
		return r[key as keyof Row] === value;
	});

vi.mock("@repo/agent-core", () => ({
	globalAgentRegistry: { get: () => undefined, getAll: () => [] },
}));
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: vi.fn(async () => ({ model: {}, metadata: {} })),
}));
vi.mock("@repo/database", () => ({
	db: {
		registeredAgent: {
			findFirst: vi.fn(
				async ({ where }: { where: Record<string, unknown> }) =>
					rows.find((r) => matches(r, where)) ?? null,
			),
			findMany: vi.fn(
				async ({ where }: { where: Record<string, unknown> }) =>
					rows.filter((r) => matches(r, where)),
			),
		},
	},
}));
vi.mock("ai", () => ({
	generateText: vi.fn(async () => ({ text: "done", usage: {} })),
	isStepCount: vi.fn(),
	tool: (definition: unknown) => definition,
}));
vi.mock("../../agent-execution-core", () => ({
	loadMcpToolsForAgent: vi.fn(),
}));
vi.mock("../../shared/agent-tool-runtime", () => ({
	prepareAgentTools: vi.fn(),
	agentToolAbortSignal: () => undefined,
}));

import { generateText } from "ai";
import { loadMcpToolsForAgent } from "../../agent-execution-core";
import { getAvailableAgents, runAgent } from "../run-agent";

const run = (agentId: string, organizationId?: string) =>
	runAgent({
		agentId,
		goal: "research",
		mode: "inline",
		currentDepth: 0,
		callingAgentId: "parent-example",
		userId: "user-example",
		organizationId,
	});

beforeEach(() => {
	vi.clearAllMocks();
});

describe("runAgent database fallback", () => {
	it.each(["system-agent", "org-agent", "own-agent"])(
		"loads %s in the caller's organization",
		async (agentId) => {
			const result = await run(agentId, "org-example");
			expect(result.success).toBe(true);
		},
	);

	it.each(["teammate-agent", "other-org-agent", "stranger-personal-agent"])(
		"refuses %s in the caller's organization",
		async (agentId) => {
			const result = await run(agentId, "org-example");
			expect(result.success).toBe(false);
			expect(result.error).toContain("not found or not accessible");
		},
	);

	it.each(["teammate-agent", "org-agent"])(
		"refuses %s when there is no organization",
		async (agentId) => {
			const result = await run(agentId);
			expect(result.success).toBe(false);
		},
	);
});

describe("getAvailableAgents", () => {
	it("lists only system, organization and the caller's own agents", async () => {
		const agents = await getAvailableAgents("user-example", "org-example");
		expect(agents.map((a) => a.id).sort()).toEqual([
			"org-agent",
			"own-agent",
			"system-agent",
		]);
	});

	it("does not list every tenant's agents when there is no organization", async () => {
		const agents = await getAvailableAgents("user-example");
		expect(agents.map((a) => a.id).sort()).toEqual([
			"own-agent",
			"system-agent",
		]);
	});
});

it("sends repeat notices to the model without replacing sub-agent tool results", async () => {
	vi.mocked(loadMcpToolsForAgent).mockResolvedValue({
		tools: { search: { execute: async () => "example result" } },
		toolToConfig: {},
	} as Awaited<ReturnType<typeof loadMcpToolsForAgent>>);
	const outputs: unknown[] = [];
	vi.mocked(generateText).mockImplementationOnce(async ({ tools }: any) => {
		for (const toolCallId of ["first", "second"]) {
			const input = { query: "example" };
			const output = await tools.search.execute(input, { toolCallId });
			expect(output).toBe("example result");
			outputs.push(
				tools.search.toModelOutput?.({ input, output, toolCallId }) ?? {
					type: "text",
					value: output,
				},
			);
		}
		return { text: "done", usage: {} } as any;
	});
	const result = await runAgent({
		agentId: "own-agent",
		goal: "example",
		mode: "inline",
		currentDepth: 0,
		callingAgentId: "parent-example",
		userId: "user-example",
		organizationId: "org-example",
		mcpConfigIds: ["example-config"],
	});
	expect(result.success).toBe(true);
	expect(outputs[0]).toEqual({ type: "text", value: "example result" });
	expect(outputs[1]).toEqual({
		type: "text",
		value: expect.stringContaining("same result"),
	});
});
