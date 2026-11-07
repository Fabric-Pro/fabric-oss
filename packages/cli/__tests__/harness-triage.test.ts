import { Command } from "commander";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	client: vi.fn(),
	context: vi.fn(),
	output: vi.fn(),
	error: vi.fn(),
	listTriageRuns: vi.fn(),
	startTriage: vi.fn(),
	getTriageResult: vi.fn(),
}));
vi.mock("../src/lib/client.js", () => ({ getClient: m.client }));
vi.mock("../src/lib/context.js", () => ({ resolveContext: m.context }));
vi.mock("../src/lib/output.js", () => ({
	printOutput: m.output,
	printError: m.error,
}));

import { registerProjectTriageCommands } from "../src/commands/projects/triage";

const run = (args: string[]) => {
	const command = new Command("projects").exitOverride();
	registerProjectTriageCommands(command);
	return command.parseAsync(args, { from: "user" });
};
beforeEach(() => {
	vi.resetAllMocks();
	m.client.mockReturnValue({ projects: m });
});

it("uses project-scoped credentials without requiring a second organization selector", async () => {
	await run(["triage", "list", "example-project"]);
	expect(m.client).toHaveBeenCalledWith({ project: "example-project" });
	expect(m.context).toHaveBeenCalledWith(undefined, undefined, false);
	expect(m.listTriageRuns).toHaveBeenCalledWith("example-project", {
		org: undefined,
		before: undefined,
	});
});
it("honors an explicit organization selector and opaque continuation", async () => {
	m.context.mockReturnValue({ type: "org", slug: "example-org" });
	await run([
		"triage",
		"list",
		"example-project",
		"--org",
		"example-org",
		"--before",
		"example-opaque",
	]);
	expect(m.context).toHaveBeenCalledWith(undefined, "example-org", false);
	expect(m.listTriageRuns).toHaveBeenCalledWith("example-project", {
		org: "example-org",
		before: "example-opaque",
	});
});
it("preserves the supplied paid-start identity and original input", async () => {
	const stderr = vi
		.spyOn(process.stderr, "write")
		.mockImplementation(() => true);
	try {
		await run([
			"triage",
			"start",
			"example-project",
			"--request-id",
			"11111111-1111-4111-8111-111111111111",
			"--goal",
			"Review delivery risks",
			"--evidence",
			"example-one,example-two",
		]);
		expect(m.startTriage).toHaveBeenCalledWith("example-project", {
			org: undefined,
			requestId: "11111111-1111-4111-8111-111111111111",
			goal: "Review delivery risks",
			evidenceIds: ["example-one", "example-two"],
		});
		expect(stderr).toHaveBeenCalledWith(
			expect.stringContaining("11111111-1111-4111-8111-111111111111"),
		);
	} finally {
		stderr.mockRestore();
	}
});

it("preserves scope error codes in machine-readable output", async () => {
	const { FabricError } = await import("@fabricorg/sdk");
	m.listTriageRuns.mockRejectedValue(
		new FabricError(
			"Required scopes are missing.",
			403,
			"INSUFFICIENT_SCOPE",
		),
	);
	const prior = process.exitCode;
	try {
		await run(["triage", "list", "example-project"]);
		expect(m.output).toHaveBeenCalledWith(
			{
				error: {
					code: "INSUFFICIENT_SCOPE",
					message: "Required scopes are missing.",
					status: 403,
				},
			},
			{ format: "json" },
		);
		expect(process.exitCode).toBe(1);
	} finally {
		process.exitCode = prior;
	}
});
