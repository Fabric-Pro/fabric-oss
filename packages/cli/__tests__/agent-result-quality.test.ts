import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	inspect: vi.fn(),
	check: vi.fn(),
	client: vi.fn(),
}));
vi.mock("../src/lib/client.js", () => ({
	getClient: (options: unknown) => {
		m.client(options);
		return {
			withoutContext: () => ({
				contextQuality: {
					inspectAgentResult: m.inspect,
					checkAgentResult: m.check,
				},
			}),
		};
	},
}));
vi.mock("../src/lib/output.js", () => ({ printOutput: vi.fn() }));

import { registerContextQualityCommands } from "../src/commands/context/quality.js";
import { printOutput } from "../src/lib/output.js";

function command() {
	const c = new Command("context");
	registerContextQualityCommands(c);
	return c;
}
afterEach(() => {
	vi.resetAllMocks();
	vi.restoreAllMocks();
});
describe("recorded run Quality CLI", () => {
	it("inspects an explicit run/project without a shared save", async () => {
		m.inspect.mockResolvedValue({ revision: "a".repeat(64) });
		await command().parseAsync(
			[
				"inspect-run",
				"example-run",
				"--project",
				"example-project",
				"--org",
				"example-team",
			],
			{ from: "user" },
		);
		expect(m.inspect).toHaveBeenCalledWith("example-run", {
			projectId: "example-project",
			org: "example-team",
		});
		expect(m.client).toHaveBeenCalledWith(
			expect.objectContaining({
				project: "example-project",
				retry: { maxRetries: 0 },
			}),
		);
	});
	it("passes repeated exact expectations and the inspected revision", async () => {
		m.check.mockResolvedValue({ status: "failed" });
		await command().parseAsync(
			[
				"check-run",
				"example-run",
				"--project",
				"example-project",
				"--revision",
				"a".repeat(64),
				"--require",
				"owner",
				"--require",
				"risk",
				"--forbid",
				"secret",
			],
			{ from: "user" },
		);
		expect(m.check).toHaveBeenCalledWith(
			"example-run",
			{
				expectedRevision: "a".repeat(64),
				requiredPhrases: ["owner", "risk"],
				forbiddenPhrases: ["secret"],
			},
			{ projectId: "example-project", org: undefined },
		);
		expect(printOutput).toHaveBeenCalledWith(
			{ status: "failed" },
			{ format: "json" },
		);
	});
	it("propagates revocation as refusal rather than an empty report", async () => {
		m.inspect.mockRejectedValue({ status: 403 });
		const stderr = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new Error(`Exit ${code}`);
		});
		await expect(
			command().parseAsync(
				["inspect-run", "example-run", "--project", "example-project"],
				{ from: "user" },
			),
		).rejects.toThrow("Exit 5");
		expect(exit).toHaveBeenCalledWith(5);
		expect(stderr).toHaveBeenCalledWith(
			expect.stringContaining("access was denied"),
		);
		expect(printOutput).not.toHaveBeenCalled();
	});
});
