import { Command, CommanderError } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildContextCommand } from "../src/commands/context/index.js";

const m = vi.hoisted(() => ({ manifest: vi.fn() }));
vi.mock("../src/lib/client.js", () => ({
	getClient: () => ({ contexts: { manifest: m.manifest } }),
}));
vi.mock("../src/lib/config.js", () => ({
	getDefaultContext: () => ({ type: "org", slug: "example-team" }),
	getOutputFormat: () => "json",
	getApiKey: () => "synthetic-key",
	getBaseUrl: () => undefined,
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
			.addCommand(buildContextCommand())
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
	m.manifest.mockResolvedValue({
		version: 1,
		sources: [],
		omissions: { sourceBodies: true },
	});
});
describe("fabric context manifest", () => {
	it("prints one live metadata page and forwards explicit source/page options", async () => {
		const result = await run([
			"context",
			"manifest",
			"--project",
			"example-project",
			"--limit",
			"5",
			"--offset",
			"10",
			"--include-code-contexts",
		]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			omissions: { sourceBodies: true },
		});
		expect(m.manifest).toHaveBeenCalledWith("example-project", {
			org: "example-team",
			limit: 5,
			offset: 10,
			includeCodeContexts: true,
		});
	});
	it.each([
		["--limit", "51"],
		["--offset", "-1"],
		["--offset", "1e2"],
		["--limit", ""],
	])(
		"rejects invalid pagination %s %s before networking",
		async (flag, value) => {
			expect(
				(
					await run([
						"context",
						"manifest",
						"--project",
						"example-project",
						flag,
						value,
					])
				).code,
			).not.toBe(0);
			expect(m.manifest).not.toHaveBeenCalled();
		},
	);
	it("requires a deliberate project scope and does not turn errors into empty success", async () => {
		expect((await run(["context", "manifest"])).code).not.toBe(0);
		m.manifest.mockRejectedValue(
			new Error("No permission to read context sources"),
		);
		const result = await run([
			"context",
			"manifest",
			"--project",
			"example-project",
		]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("No permission");
	});
});
