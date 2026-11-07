import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	listDeliverySignals: vi.fn(),
	getDeliverySignal: vi.fn(),
	getDeliverySignalSourceConfiguration: vi.fn(),
	output: vi.fn(),
	getClient: vi.fn(),
	error: vi.fn((message: string) => {
		throw Error(message);
	}),
}));
vi.mock("../src/lib/client.js", () => ({ getClient: m.getClient }));
vi.mock("../src/lib/context.js", () => ({
	resolveContext: (_: unknown, org?: string) => ({
		type: "org",
		slug: org ?? "example-org",
	}),
}));
vi.mock("../src/lib/output.js", () => ({
	printOutput: m.output,
	printError: m.error,
}));

import { FabricError } from "@fabricorg/sdk";
import { registerProjectSignalCommands } from "../src/commands/projects/signals";

function run(args: string[]) {
	const command = new Command("projects")
		.exitOverride()
		.option("--format <format>");
	registerProjectSignalCommands(command);
	return command.parseAsync(args, { from: "user" });
}
beforeEach(() => {
	vi.clearAllMocks();
	m.getClient.mockReturnValue({ projects: m });
});
describe("delivery history CLI", () => {
	it.each([
		"INSUFFICIENT_SCOPE",
		"INSUFFICIENT_PERMISSION",
		"ORGANIZATION_DELETED",
	])(
		"retains the %s semantic refusal in machine-readable output",
		async (code) => {
			m.listDeliverySignals.mockRejectedValueOnce(
				new FabricError("Current access refused.", 403, code),
			);
			const exit = vi.spyOn(process, "exit").mockImplementation(() => {
				throw Error("example-exit");
			});
			try {
				await expect(
					run([
						"signals",
						"list",
						"example-project",
						"--format",
						"json",
					]),
				).rejects.toThrow("example-exit");
				expect(m.output).toHaveBeenCalledWith(
					{
						error: {
							code,
							message: "Current access refused.",
							status: 403,
						},
					},
					{ format: "json" },
				);
			} finally {
				exit.mockRestore();
			}
		},
	);
	it("preserves project-specific credentials, filters and cursor", async () => {
		await run([
			"signals",
			"list",
			"example-project",
			"--source",
			"azure-devops",
			"--search",
			"release",
			"--cursor",
			"example-cursor",
			"--limit",
			"5",
		]);
		expect(m.getClient).toHaveBeenCalledWith({
			project: "example-project",
		});
		expect(m.listDeliverySignals).toHaveBeenCalledWith("example-project", {
			org: "example-org",
			source: "AZURE_DEVOPS",
			search: "release",
			cursor: "example-cursor",
			limit: 5,
		});
	});
	it("honors inherited global format and selected organization", async () => {
		await run([
			"--format",
			"yaml",
			"signals",
			"show",
			"example-project",
			"example-item",
			"--org",
			"example-team",
		]);
		expect(m.getDeliverySignal).toHaveBeenCalledWith(
			"example-project",
			"example-item",
			{ org: "example-team" },
		);
		expect(m.output).toHaveBeenCalledWith(undefined, { format: "yaml" });
	});
	it("reads saved settings through the SDK without triggering capture", async () => {
		await run(["signals", "sources", "example-project"]);
		expect(m.getDeliverySignalSourceConfiguration).toHaveBeenCalledWith(
			"example-project",
			{ org: "example-org" },
		);
	});
});
