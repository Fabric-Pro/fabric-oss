import { Command, CommanderError } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildWorkspacesCommand } from "../src/commands/workspaces/index.js";

const m = vi.hoisted(() => ({ read: vi.fn(), list: vi.fn() }));
vi.mock("../src/lib/client.js", () => ({
	getClient: () => ({
		workspaces: { readDocument: m.read, listDocuments: m.list },
	}),
}));
vi.mock("../src/lib/config.js", () => ({
	getDefaultContext: () => ({ type: "org", slug: "example-team" }),
	getOutputFormat: () => "table",
}));
class ExitSignal extends Error {
	constructor(readonly code: number) {
		super("exit");
	}
}
async function run(args: string[]) {
	let stdout = "",
		stderr = "",
		code = 0;
	const out = vi
		.spyOn(process.stdout, "write")
		.mockImplementation((chunk: unknown) => {
			stdout += String(chunk);
			return true;
		});
	const err = vi
		.spyOn(process.stderr, "write")
		.mockImplementation((chunk: unknown) => {
			stderr += String(chunk);
			return true;
		});
	const exit = vi.spyOn(process, "exit").mockImplementation((value) => {
		throw new ExitSignal(Number(value ?? 0));
	});
	try {
		await new Command("fabric")
			.exitOverride()
			.addCommand(buildWorkspacesCommand())
			.parseAsync(args, { from: "user" });
	} catch (error) {
		if (error instanceof ExitSignal) code = error.code;
		else if (error instanceof CommanderError) code = error.exitCode;
		else throw error;
	} finally {
		out.mockRestore();
		err.mockRestore();
		exit.mockRestore();
	}
	return { code, stdout, stderr };
}
beforeEach(() => {
	vi.resetAllMocks();
	m.read.mockResolvedValue({
		text: "A😀",
		revision: "a".repeat(64),
		nextOffset: 2,
	});
	m.list.mockResolvedValue({
		documents: [{ id: "example-document", status: "READY" }],
		total: 1,
		nextOffset: null,
	});
});
describe("Workspace document CLI", () => {
	it("returns revision/continuation JSON and uses the stored organization", async () => {
		const result = await run([
			"workspaces",
			"read-document",
			"example-workspace",
			"example-document",
			"--limit",
			"2",
		]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			text: "A😀",
			revision: "a".repeat(64),
			nextOffset: 2,
		});
		expect(m.read).toHaveBeenCalledWith(
			"example-workspace",
			"example-document",
			{
				org: "example-team",
				offset: 0,
				limit: 2,
				expectedRevision: undefined,
			},
		);
	});
	it("forwards an explicit organization and continuation revision", async () => {
		await run([
			"workspaces",
			"read-document",
			"example-workspace",
			"example-document",
			"--org",
			"other-team",
			"--offset",
			"2",
			"--expected-revision",
			"a".repeat(64),
		]);
		expect(m.read).toHaveBeenCalledWith(
			"example-workspace",
			"example-document",
			expect.objectContaining({
				org: "other-team",
				offset: 2,
				expectedRevision: "a".repeat(64),
			}),
		);
	});
	it.each([
		["--limit", "20001"],
		["--limit", "2.5"],
		["--offset", "-1"],
		["--offset", "NaN"],
		["--offset", "1"],
		["--expected-revision", "invalid"],
	])(
		"rejects invalid request %s %s without a remote read",
		async (flag, value) => {
			expect(
				(
					await run([
						"workspaces",
						"read-document",
						"example-workspace",
						"example-document",
						flag,
						value,
					])
				).code,
			).not.toBe(0);
			expect(m.read).not.toHaveBeenCalled();
		},
	);
	it("lists document IDs/status without AI search", async () => {
		const result = await run([
			"workspaces",
			"documents",
			"example-workspace",
			"--limit",
			"10",
		]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			documents: [{ id: "example-document", status: "READY" }],
		});
		expect(m.list).toHaveBeenCalledWith("example-workspace", {
			org: "example-team",
			offset: 0,
			limit: 10,
		});
	});
	it("surfaces a stale revision as a failed command and never silently restarts", async () => {
		m.read.mockRejectedValue(
			new Error(
				"Document content changed. Restart at offset 0 before continuing.",
			),
		);
		const result = await run([
			"workspaces",
			"read-document",
			"example-workspace",
			"example-document",
		]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Restart at offset 0");
		expect(m.read).toHaveBeenCalledTimes(1);
	});
});
