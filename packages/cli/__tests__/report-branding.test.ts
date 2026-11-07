import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	read: vi.fn(),
	get: vi.fn(),
	apply: vi.fn(),
	out: vi.fn(),
	error: vi.fn((value: string) => {
		throw new Error(value);
	}),
}));
vi.mock("node:fs/promises", () => ({ readFile: m.read }));
vi.mock("../src/lib/client.js", () => ({
	getClient: () => ({
		reports: { getInstanceBranding: m.get, applyInstanceBranding: m.apply },
	}),
}));
vi.mock("../src/lib/context.js", () => ({
	resolveContext: () => ({ slug: "example-org" }),
}));
vi.mock("../src/lib/output.js", () => ({
	printError: m.error,
	printOutput: m.out,
	printRecord: m.out,
}));

import { buildReportsCommand } from "../src/commands/reports/index.js";

const run = (args: string[]) =>
	buildReportsCommand().exitOverride().parseAsync(args, { from: "user" });
beforeEach(() => vi.clearAllMocks());
describe("report branding CLI", () => {
	it("reviews exact report identity", async () => {
		m.get.mockResolvedValue({ instanceVersion: 2 });
		await run(["branding", "show", "example-report"]);
		expect(m.get).toHaveBeenCalledWith("example-report", {
			org: "example-org",
		});
	});
	it("sends reviewed CAS and nullable branding without running a report", async () => {
		const input = {
			expectedInstanceVersion: 2,
			expectedUpdatedAt: "2026-11-01T00:00:00Z",
			branding: null,
		};
		m.read.mockResolvedValue(JSON.stringify(input));
		m.apply.mockResolvedValue({ instanceVersion: 2 });
		await run([
			"branding",
			"apply",
			"example-report",
			"--file",
			"example.json",
		]);
		expect(m.apply).toHaveBeenCalledWith("example-report", input, {
			org: "example-org",
		});
	});
	it("rejects an oversized file before any API mutation", async () => {
		m.read.mockResolvedValue("x".repeat(16385));
		await expect(
			run([
				"branding",
				"apply",
				"example-report",
				"--file",
				"example.json",
			]),
		).rejects.toThrow("16 KiB");
		expect(m.apply).not.toHaveBeenCalled();
	});
});
