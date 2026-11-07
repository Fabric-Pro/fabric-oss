import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	read: vi.fn(),
	delivery: vi.fn(),
	listImplementationSessions: vi.fn(),
	getImplementationSession: vi.fn(),
	getImplementationMessages: vi.fn(),
	startImplementationSession: vi.fn(),
	cancelImplementationSession: vi.fn(),
	followUpImplementationSession: vi.fn(),
	output: vi.fn(),
	error: vi.fn((message: string) => {
		throw Error(message);
	}),
}));
vi.mock("node:fs/promises", () => ({ readFile: m.read }));
vi.mock("../src/lib/client.js", () => ({ getClient: () => ({ projects: m }) }));
vi.mock("../src/lib/context.js", () => ({
	resolveContext: (_p: unknown, org?: string) => ({
		type: "org",
		slug: org ?? "example-org",
	}),
}));
vi.mock("../src/lib/output.js", () => ({
	printOutput: m.output,
	printError: m.error,
}));

import { registerProjectDeliveryCommand } from "../src/commands/projects/delivery.js";
import { registerImplementationCommands } from "../src/commands/projects/implementations.js";

function run(args: string[]) {
	const command = new Command("projects").exitOverride();
	registerProjectDeliveryCommand(command);
	registerImplementationCommands(command);
	return command.parseAsync(args, { from: "user" });
}
beforeEach(() => {
	vi.clearAllMocks();
	m.read.mockResolvedValue("Continue with the reviewed plan");
});
describe("project delivery CLI controls", () => {
	it("prints unavailable evidence distinctly without inventing zero counts", async () => {
		const evidence = {
			decisions: { available: false, items: [] },
			documents: { available: false, items: [] },
		};
		m.delivery.mockResolvedValue(evidence);
		await run(["delivery", "example-project"]);
		expect(m.output).toHaveBeenCalledWith(evidence, { format: "json" });
	});
	it("uses the SDK delivery query and selected organization", async () => {
		await run(["delivery", "example-project", "--org", "example-team"]);
		expect(m.delivery).toHaveBeenCalledWith("example-project", {
			org: "example-team",
		});
	});
	it("pages implementation sessions by stable server cursor", async () => {
		await run([
			"implementations",
			"list",
			"example-project",
			"--story",
			"example-story",
			"--cursor",
			"example-run",
			"--limit",
			"25",
		]);
		expect(m.listImplementationSessions).toHaveBeenCalledWith(
			"example-project",
			{
				org: "example-org",
				storyId: "example-story",
				cursor: "example-run",
				limit: 25,
			},
		);
	});
	it.each([
		["show", "getImplementationSession"],
		["messages", "getImplementationMessages"],
		["cancel", "cancelImplementationSession"],
	] as const)(
		"%s targets the exact existing session",
		async (name, method) => {
			await run([
				"implementations",
				name,
				"example-project",
				"example-run",
			]);
			expect(m[method]).toHaveBeenCalledWith(
				"example-project",
				"example-run",
				{ org: "example-org" },
			);
		},
	);
	it("keeps an explicit start request identity from a JSON file", async () => {
		const input = {
			requestId: "00000000-0000-4000-8000-000000000001",
			storyId: "example-story",
		};
		m.read.mockResolvedValue(JSON.stringify(input));
		await run([
			"implementations",
			"start",
			"example-project",
			"--input",
			"example.json",
		]);
		expect(m.startImplementationSession).toHaveBeenCalledWith(
			"example-project",
			{ ...input, org: "example-org" },
		);
	});
	it("sends follow-up text as data with a stable prompt identity", async () => {
		const promptId = "00000000-0000-4000-8000-000000000002";
		await run([
			"implementations",
			"follow-up",
			"example-project",
			"example-run",
			"--prompt-id",
			promptId,
			"--message-file",
			"example.txt",
		]);
		expect(m.followUpImplementationSession).toHaveBeenCalledWith(
			"example-project",
			"example-run",
			{
				org: "example-org",
				promptId,
				message: "Continue with the reviewed plan",
			},
		);
	});
});
