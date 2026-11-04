import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerContextDocumentCommands } from "../src/commands/context/documents.js";

const m = vi.hoisted(() => ({
	client: vi.fn(),
	linkedDocuments: vi.fn(),
	linkWorkspaceDocument: vi.fn(),
	unlinkWorkspaceDocument: vi.fn(),
	readLinkedDocument: vi.fn(),
}));
vi.mock("../src/lib/client.js", () => ({
	getClient: (options: unknown) => {
		m.client(options);
		return { withoutContext: () => ({ contexts: m }) };
	},
}));
vi.mock("../src/lib/output.js", () => ({
	printOutput: vi.fn(),
	printError: vi.fn(),
}));

import { printError, printOutput } from "../src/lib/output.js";

function command() {
	const c = new Command("context")
		.exitOverride()
		.configureOutput({ writeErr: () => {} });
	registerContextDocumentCommands(c);
	return c;
}
afterEach(() => vi.resetAllMocks());
describe("fabric context documents", () => {
	it.each([
		[
			"list",
			[],
			"linkedDocuments",
			["example-project", { org: "example-team", limit: 20, offset: 0 }],
		],
		[
			"add",
			[
				"example-document",
				"--workspace",
				"example-workspace",
				"--revision",
				"a".repeat(64),
			],
			"linkWorkspaceDocument",
			[
				"example-project",
				{
					workspaceId: "example-workspace",
					documentId: "example-document",
					expectedRevision: "a".repeat(64),
				},
				{ org: "example-team" },
			],
		],
		[
			"remove",
			["example-link"],
			"unlinkWorkspaceDocument",
			["example-project", "example-link", { org: "example-team" }],
		],
		[
			"read",
			[
				"example-link",
				"--offset",
				"1",
				"--limit",
				"20",
				"--revision",
				"b".repeat(64),
			],
			"readLinkedDocument",
			[
				"example-project",
				"example-link",
				{
					org: "example-team",
					offset: 1,
					limit: 20,
					expectedRevision: "b".repeat(64),
				},
			],
		],
	] as const)(
		"routes %s through the explicit project and organization",
		async (action, args, method, expected) => {
			m[method].mockResolvedValue({ verified: true });
			await command().parseAsync(
				[
					"documents",
					action,
					...args,
					"--project",
					"example-project",
					"--org",
					"example-team",
				],
				{ from: "user" },
			);
			expect(m.client).toHaveBeenCalledWith({
				project: "example-project",
			});
			expect(m[method]).toHaveBeenCalledWith(...expected);
			expect(printOutput).toHaveBeenCalledWith(
				{ verified: true },
				{ format: "json" },
			);
		},
	);
	it.each(["-1", "1.5", "20001", "Infinity", "0"])(
		"rejects invalid read limit %s before networking",
		async (limit) => {
			await expect(
				command().parseAsync(
					[
						"documents",
						"read",
						"example-link",
						"--project",
						"example-project",
						"--limit",
						limit,
					],
					{ from: "user" },
				),
			).rejects.toThrow();
			expect(m.readLinkedDocument).not.toHaveBeenCalled();
		},
	);
	it("reports refusal without printing an empty success", async () => {
		m.linkedDocuments.mockRejectedValue(
			new Error("Current access required."),
		);
		await command().parseAsync(
			["documents", "list", "--project", "example-project"],
			{ from: "user" },
		);
		expect(printError).toHaveBeenCalledWith("Current access required.", 1);
		expect(printOutput).not.toHaveBeenCalled();
	});
});
