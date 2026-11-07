import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	create: vi.fn(),
	read: vi.fn(),
	output: vi.fn(),
	error: vi.fn((message: string) => {
		throw new Error(message);
	}),
}));
vi.mock("node:fs/promises", () => ({ readFile: m.read }));
vi.mock("../src/lib/client.js", () => ({
	getClient: () => ({
		withoutContext: () => ({ projects: { createDocument: m.create } }),
	}),
}));
vi.mock("../src/lib/output.js", () => ({
	printOutput: m.output,
	printError: m.error,
}));

import { registerProjectDocumentCommands } from "../src/commands/projects/documents.js";

const run = (extra: string[]) => {
	const command = new Command().exitOverride();
	registerProjectDocumentCommands(command);
	return command.parseAsync(
		[
			"documents",
			"create",
			"example-project",
			"--title",
			"Example proposal",
			"--content-file",
			"example.md",
			...extra,
		],
		{ from: "user" },
	);
};
beforeEach(() => {
	vi.clearAllMocks();
	m.read.mockResolvedValue("# Example proposal");
});
describe("branded project documents CLI", () => {
	it("forwards the deliberately selected palette and reviewed version to the SDK", async () => {
		await run([
			"--type",
			"PROPOSAL",
			"--branding",
			"client",
			"--recipient-version",
			"2",
		]);
		expect(m.create).toHaveBeenCalledWith(
			"example-project",
			expect.objectContaining({
				proposalBranding: "CLIENT",
				recipientBrandVersion: 2,
				content: "# Example proposal",
			}),
		);
	});
	it.each([
		{
			args: ["--type", "PROPOSAL", "--branding", "client"],
			message: "--recipient-version",
		},
		{
			args: ["--type", "GENERAL", "--branding", "company"],
			message: "PROPOSAL",
		},
		{ args: ["--recipient-version", "2"], message: "--recipient-version" },
	])(
		"refuses inconsistent brand selection $args before reading or sending content",
		async ({ args, message }) => {
			await expect(run(args)).rejects.toThrow(message);
			expect(m.read).not.toHaveBeenCalled();
			expect(m.create).not.toHaveBeenCalled();
		},
	);
});
