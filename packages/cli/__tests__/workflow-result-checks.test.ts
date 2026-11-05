import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	listChecks: vi.fn(),
	inspectResult: vi.fn(),
	previewCheck: vi.fn(),
	saveCheck: vi.fn(),
	applyCheck: vi.fn(),
	removeCheck: vi.fn(),
	output: vi.fn(),
	error: vi.fn((message: string) => {
		throw Error(message);
	}),
}));
vi.mock("../src/lib/client.js", () => ({
	getClient: () => ({ workflows: m }),
}));
vi.mock("../src/lib/context.js", () => ({
	resolveContext: (_p: unknown, org?: string) => ({
		type: "org",
		slug: org ?? "example-org",
	}),
}));
vi.mock("../src/lib/output.js", () => ({
	printOutput: m.output,
	printError: m.error,
	printSuccess: vi.fn(),
	printRecord: vi.fn(),
}));

import { buildWorkflowsCommand } from "../src/commands/workflows/index.js";

const run = (args: string[]) =>
	buildWorkflowsCommand()
		.exitOverride()
		.parseAsync(["checks", ...args], { from: "user" });
const revision = "a".repeat(64);
beforeEach(() => vi.clearAllMocks());
it("lists and inspects with the chosen organization", async () => {
	await run(["list", "example-workflow", "--org", "example-team"]);
	expect(m.listChecks).toHaveBeenCalledWith("example-workflow", {
		org: "example-team",
	});
	await run(["inspect", "example-workflow", "example-run", "draft"]);
	expect(m.inspectResult).toHaveBeenCalledWith(
		"example-workflow",
		{ executionId: "example-run", nodeId: "draft" },
		{ org: "example-org" },
	);
});
it("previews and saves exact expectations with an inspected revision", async () => {
	await run([
		"preview",
		"example-workflow",
		"example-run",
		"draft",
		"--revision",
		revision,
		"--require",
		"Next steps",
		"--require",
		"Risks",
		"--forbid",
		"No risks remain",
	]);
	expect(m.previewCheck).toHaveBeenCalledWith(
		"example-workflow",
		{
			executionId: "example-run",
			nodeId: "draft",
			expectedRevision: revision,
			requiredPhrases: ["Next steps", "Risks"],
			forbiddenPhrases: ["No risks remain"],
		},
		{ org: "example-org" },
	);
	await run([
		"save",
		"example-workflow",
		"example-run",
		"draft",
		"--revision",
		revision,
		"--require",
		"Next steps",
		"--name",
		"Delivery evidence",
	]);
	expect(m.saveCheck.mock.calls[0][1].name).toBe("Delivery evidence");
});
it("compares and removes the specific saved revision", async () => {
	await run([
		"compare",
		"example-workflow",
		"example-check",
		"example-candidate",
		"--revision",
		revision,
	]);
	expect(m.applyCheck).toHaveBeenCalledWith(
		"example-workflow",
		{
			checkId: "example-check",
			executionId: "example-candidate",
			expectedCaseRevision: revision,
		},
		{ org: "example-org" },
	);
	await run([
		"remove",
		"example-workflow",
		"example-check",
		"--revision",
		revision,
	]);
	expect(m.removeCheck).toHaveBeenCalledWith(
		"example-workflow",
		{ checkId: "example-check", expectedCaseRevision: revision },
		{ org: "example-org" },
	);
});
