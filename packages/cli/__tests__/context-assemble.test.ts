import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	readContextSelectionFile,
	registerContextAssembleCommand,
} from "../src/commands/context/assemble.js";

const m = vi.hoisted(() => ({ assemble: vi.fn() }));
vi.mock("../src/lib/client.js", () => ({
	getClient: () => ({
		withoutContext: () => ({ contexts: { assemble: m.assemble } }),
	}),
}));
vi.mock("../src/lib/output.js", () => ({
	printOutput: vi.fn(),
	printError: vi.fn(),
}));

import { printError, printOutput } from "../src/lib/output.js";

const dirs: string[] = [];
async function fixture(value: string) {
	const dir = await mkdtemp(join(tmpdir(), "example-selection-"));
	dirs.push(dir);
	const path = join(dir, "selection.json");
	await writeFile(path, value);
	return path;
}
afterEach(async () => {
	vi.clearAllMocks();
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});
describe("fabric context assemble", () => {
	it("uses only the explicit file references and organization, and prints the actual packet", async () => {
		const input = {
			selections: [
				{
					sourceKind: "workspace_document",
					workspaceId: "example-workspace",
					documentId: "example-document",
					expectedRevision: "a".repeat(64),
				},
			],
		};
		const path = await fixture(JSON.stringify(input));
		const packet = { sources: [], omissions: [], selectionHash: "example" };
		m.assemble.mockResolvedValue(packet);
		const command = new Command("context");
		registerContextAssembleCommand(command);
		await command.parseAsync(
			[
				"assemble",
				"--project",
				"example-project",
				"--selection-file",
				path,
				"--org",
				"example-team",
			],
			{ from: "user" },
		);
		expect(m.assemble).toHaveBeenCalledWith("example-project", input, {
			org: "example-team",
		});
		expect(printOutput).toHaveBeenCalledWith(packet, { format: "json" });
	});
	it.each([
		"x",
		'{"selections":[]}',
		JSON.stringify({ selections: Array(13).fill({}) }),
		JSON.stringify({ selections: [{}], organizationId: "example-other" }),
		" ".repeat(16385),
	])(
		"refuses invalid or oversized input before networking",
		async (value) => {
			const path = await fixture(value);
			await expect(readContextSelectionFile(path)).rejects.toThrow();
			expect(m.assemble).not.toHaveBeenCalled();
		},
	);
	it("propagates denied current reads as errors, not empty success", async () => {
		const path = await fixture(
			'{"selections":[{"sourceKind":"project_context","sourceId":"example-source"}]}',
		);
		m.assemble.mockRejectedValue(new Error("Current permission required."));
		const command = new Command("context");
		registerContextAssembleCommand(command);
		await command.parseAsync(
			[
				"assemble",
				"--project",
				"example-project",
				"--selection-file",
				path,
			],
			{ from: "user" },
		);
		expect(printError).toHaveBeenCalledWith(
			"Current permission required.",
			1,
		);
		expect(printOutput).not.toHaveBeenCalled();
	});
});
