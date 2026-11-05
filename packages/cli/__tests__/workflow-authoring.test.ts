import { expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	listStarters: vi.fn(),
	createFromStarter: vi.fn(),
	checkReadiness: vi.fn(),
	output: vi.fn(),
	error: vi.fn(),
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
	printRecord: vi.fn(),
	printSuccess: vi.fn(),
}));

import { buildWorkflowsCommand } from "../src/commands/workflows/index.js";

const run = (args: string[]) =>
	buildWorkflowsCommand().exitOverride().parseAsync(args, { from: "user" });
it("uses the same org-scoped SDK operations for starters and configuration checks", async () => {
	await run(["starters", "--org", "example-team"]);
	expect(m.listStarters).toHaveBeenCalledWith({ org: "example-team" });
	await run(["from-starter", "action-plan", "--name", "Example plan"]);
	expect(m.createFromStarter).toHaveBeenCalledWith(
		{ starterId: "action-plan", name: "Example plan" },
		{ org: "example-org" },
	);
	await run(["check", "example-workflow"]);
	expect(m.checkReadiness).toHaveBeenCalledWith("example-workflow", {
		org: "example-org",
	});
});
