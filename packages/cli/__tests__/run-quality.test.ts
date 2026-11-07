import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	getPolicy: vi.fn(),
	configure: vi.fn(),
	list: vi.fn(),
	get: vi.fn(),
	cancel: vi.fn(),
	compare: vi.fn(),
	read: vi.fn(),
	output: vi.fn(),
	error: vi.fn((message: string) => {
		throw new Error(message);
	}),
}));
vi.mock("node:fs/promises", () => ({ readFile: m.read }));
vi.mock("../src/lib/client.js", () => ({
	getClient: () => ({ runQuality: m }),
}));
vi.mock("../src/lib/context.js", () => ({
	resolveContext: (_project: unknown, org?: string) => ({
		type: "org",
		slug: org ?? "example-org",
	}),
}));
vi.mock("../src/lib/output.js", () => ({
	printOutput: m.output,
	printError: m.error,
}));

import { buildRunQualityCommand } from "../src/commands/run-quality/index.js";

const run = (args: string[]) =>
	buildRunQualityCommand().exitOverride().parseAsync(args, { from: "user" });
beforeEach(() => vi.clearAllMocks());
it("routes each read/cancel/compare to an explicit target without triggering business execution", async () => {
	await run(["policy", "agent", "example-agent", "--org", "example-team"]);
	expect(m.getPolicy).toHaveBeenCalledWith(
		{ targetType: "AGENT", targetId: "example-agent" },
		{ org: "example-team" },
	);
	await run([
		"list",
		"workflow",
		"example-flow",
		"--limit",
		"5",
		"--offset",
		"10",
	]);
	expect(m.list).toHaveBeenCalledWith(
		{ targetType: "WORKFLOW", targetId: "example-flow" },
		{ org: "example-org", limit: 5, offset: 10 },
	);
	await run(["show", "agent", "example-agent", "example-assessment"]);
	expect(m.get).toHaveBeenCalledWith(
		{
			targetType: "AGENT",
			targetId: "example-agent",
			assessmentId: "example-assessment",
		},
		{ org: "example-org" },
	);
	await run(["cancel", "agent", "example-agent", "example-assessment"]);
	expect(m.cancel).toHaveBeenCalledWith(
		{
			targetType: "AGENT",
			targetId: "example-agent",
			assessmentId: "example-assessment",
		},
		{ org: "example-org" },
	);
	await run(["compare", "workflow", "example-flow", "left", "right"]);
	expect(m.compare).toHaveBeenCalledWith(
		{
			targetType: "WORKFLOW",
			targetId: "example-flow",
			leftId: "left",
			rightId: "right",
		},
		{ org: "example-org" },
	);
});
it("preserves reviewed rules/revision but refuses request authority overrides", async () => {
	const input = {
		expectedRevision: 3,
		enabled: true,
		rules: [
			{
				id: "check",
				name: "Result",
				required: true,
				checks: {
					version: 2,
					jsonAssertions: [{ pointer: "/ready", equals: true }],
				},
			},
		],
	};
	m.read.mockResolvedValue(Buffer.from(JSON.stringify(input)));
	await run(["configure", "agent", "example-agent", "example.json"]);
	expect(m.configure).toHaveBeenCalledWith(
		{ ...input, targetType: "AGENT", targetId: "example-agent" },
		{ org: "example-org" },
	);
	m.read.mockResolvedValue(
		Buffer.from(JSON.stringify({ ...input, targetId: "different" })),
	);
	await expect(
		run(["configure", "agent", "example-agent", "example.json"]),
	).rejects.toThrow(/omit actor/);
	expect(m.configure).toHaveBeenCalledTimes(1);
});
it.each([
	["list", "agent", "example", "--limit", "51"],
	["list", "agent", "example", "--offset", "-1"],
	["policy", "person", "example"],
])("rejects invalid options %j before calling the SDK", async (...args) => {
	await expect(run(args)).rejects.toThrow();
	expect(m.list).not.toHaveBeenCalled();
	expect(m.getPolicy).not.toHaveBeenCalled();
});
