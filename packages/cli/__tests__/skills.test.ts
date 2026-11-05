import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	listPage: vi.fn(),
	get: vi.fn(),
	create: vi.fn(),
	update: vi.fn(),
	archive: vi.fn(),
	restore: vi.fn(),
	publish: vi.fn(),
	delete: vi.fn(),
	assist: vi.fn(),
	previewImport: vi.fn(),
	createImport: vi.fn(),
	readFile: vi.fn(),
	readImportFile: vi.fn(),
	getGovernance: vi.fn(),
	updateGovernance: vi.fn(),
	read: vi.fn(),
	output: vi.fn(),
	error: vi.fn((message: string) => {
		throw Error(message);
	}),
}));
vi.mock("node:fs/promises", () => ({ readFile: m.read }));
vi.mock("../src/lib/client.js", () => ({ getClient: () => ({ skills: m }) }));
vi.mock("../src/lib/context.js", () => ({
	resolveContext: (_personal: unknown, org?: string) => ({
		type: "org",
		slug: org ?? "example-org",
	}),
}));
vi.mock("../src/lib/output.js", () => ({
	printOutput: m.output,
	printError: m.error,
}));

import { buildSkillsCommand } from "../src/commands/skills/index.js";

const run = (args: string[]) =>
	new Command("fabric")
		.version("0.0.0")
		.exitOverride()
		.addCommand(buildSkillsCommand())
		.parseAsync(["skills", ...args], { from: "user" });
beforeEach(() => {
	vi.clearAllMocks();
	for (const name of [
		"listPage",
		"get",
		"create",
		"update",
		"archive",
		"restore",
		"publish",
		"delete",
		"assist",
		"previewImport",
		"createImport",
		"readFile",
		"readImportFile",
		"getGovernance",
		"updateGovernance",
	] as const) {
		m[name].mockResolvedValue({ id: "example-result" });
	}
});
describe("governed Skills CLI", () => {
	it("lists truthful page metadata and validated pagination", async () => {
		await run([
			"list",
			"--tab",
			"drafts",
			"--limit",
			"5",
			"--offset",
			"10",
		]);
		expect(m.listPage).toHaveBeenCalledWith(
			expect.objectContaining({
				org: "example-org",
				tab: "drafts",
				limit: 5,
				offset: 10,
			}),
		);
	});
	it.each([
		["create", "create"],
		["assist", "assist"],
		["import create", "createImport"],
		["import read-file", "readImportFile"],
		["governance update", "updateGovernance"],
	])(
		"passes exact JSON body for %s without generating new data",
		async (command, method) => {
			const input = {
				name: "Example",
				content: "Review the change",
				candidateKey: "example.md",
				expectedHash: "a".repeat(64),
			};
			m.read.mockResolvedValue(Buffer.from(JSON.stringify(input)));
			await run([...command.split(" "), "example.json"]);
			expect(m[method as "create"]).toHaveBeenCalledWith(input, {
				org: "example-org",
			});
		},
	);
	it("pins updates and publication to the expected current version", async () => {
		m.read.mockResolvedValue(
			Buffer.from(
				JSON.stringify({ name: "Example", expectedVersion: 2 }),
			),
		);
		await run(["update", "example-skill", "example.json"]);
		expect(m.update).toHaveBeenCalledWith(
			"example-skill",
			{ name: "Example", expectedVersion: 2 },
			{ org: "example-org" },
		);
		await run([
			"publish",
			"example-skill",
			"--expected-version",
			"2",
			"--availability",
			"agents",
		]);
		expect(m.publish).toHaveBeenCalledWith(
			"example-skill",
			{ expectedVersion: 2, availability: "agents" },
			{ org: "example-org" },
		);
	});
	it.each(["archive", "restore"])(
		"uses reversible %s rather than permanent deletion",
		async (operation) => {
			await run([operation, "example-skill", "--expected-version", "2"]);
			expect(m[operation as "archive"]).toHaveBeenCalledWith(
				"example-skill",
				{ expectedVersion: 2 },
				{ org: "example-org" },
			);
			expect(m.delete).not.toHaveBeenCalled();
		},
	);
	it("makes permanent deletion deliberate", async () => {
		await expect(run(["delete", "example-skill"])).rejects.toThrow(
			"--confirm-permanent",
		);
		expect(m.delete).not.toHaveBeenCalled();
		await run(["delete", "example-skill", "--confirm-permanent"]);
		expect(m.delete).toHaveBeenCalledWith("example-skill", {
			org: "example-org",
			expectedVersion: undefined,
		});
	});
	it("encodes only an explicitly selected local import file", async () => {
		m.read.mockResolvedValue(Buffer.from("Example"));
		await run(["import", "preview", "example.md"]);
		expect(m.previewImport).toHaveBeenCalledWith(
			{
				source: {
					kind: "file",
					fileName: "example.md",
					base64: "RXhhbXBsZQ==",
				},
			},
			{ org: "example-org" },
		);
	});
	it("pins public GitHub imports to the inspected revision and hash", async () => {
		await run([
			"import",
			"apply",
			"https://github.com/example/skills",
			"--ref",
			"example-commit",
			"--candidate-key",
			"example/SKILL.md",
			"--expected-hash",
			"a".repeat(64),
		]);
		expect(m.createImport).toHaveBeenCalledWith(
			{
				source: {
					kind: "github",
					url: "https://github.com/example/skills",
					ref: "example-commit",
				},
				candidateKey: "example/SKILL.md",
				expectedHash: "a".repeat(64),
			},
			{ org: "example-org" },
		);
	});
	it("reads an authorized persisted file using its version", async () => {
		await run([
			"file",
			"example-skill",
			"references/example.md",
			"--expected-version",
			"2",
		]);
		expect(m.readFile).toHaveBeenCalledWith(
			"example-skill",
			{ path: "references/example.md", expectedVersion: 2 },
			{ org: "example-org" },
		);
	});
	it.each(["0", "101", "1.5", "-1"])(
		"rejects invalid pagination %s",
		async (limit) => {
			await expect(run(["list", "--limit", limit])).rejects.toThrow(
				"--limit",
			);
			expect(m.listPage).not.toHaveBeenCalled();
		},
	);
	it("refuses oversized local files before a network request", async () => {
		m.read.mockResolvedValue(Buffer.alloc(8 * 1024 * 1024 + 1));
		await expect(run(["import", "preview", "example.zip"])).rejects.toThrow(
			"8 MiB",
		);
		expect(m.previewImport).not.toHaveBeenCalled();
	});
});
