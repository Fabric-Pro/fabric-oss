import { Command } from "commander";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	read: vi.fn(),
	getResponseContract: vi.fn(),
	setResponseContract: vi.fn(),
	assist: vi.fn(),
	preview: vi.fn(),
	output: vi.fn(),
	error: vi.fn((message: string) => {
		throw Error(message);
	}),
}));
vi.mock("node:fs/promises", () => ({ readFile: m.read }));
vi.mock("../src/lib/client.js", () => ({ getClient: () => ({ prompts: m }) }));
vi.mock("../src/lib/context.js", () => ({
	resolveContext: (_p: unknown, org?: string) => ({
		type: "org",
		slug: org || "example-org",
	}),
}));
vi.mock("../src/lib/output.js", () => ({
	printOutput: m.output,
	printError: m.error,
	printRecord: vi.fn(),
	printSuccess: vi.fn(),
}));

import { buildPromptsCommand } from "../src/commands/prompts/index.js";

const run = (args: string[]) =>
	new Command("fabric")
		.exitOverride()
		.addCommand(buildPromptsCommand())
		.parseAsync(["prompts", ...args], { from: "user" });
beforeEach(() => {
	vi.clearAllMocks();
	m.read.mockResolvedValue(
		Buffer.from(JSON.stringify({ draft: { content: "Reply briefly" } })),
	);
	m.assist.mockResolvedValue({ message: "Review" });
	m.preview.mockResolvedValue({ output: "Example" });
});
it.each(["assist", "preview"] as const)(
	"provides %s using an explicit request file and current org",
	async (mode) => {
		await run([mode, "example.json", "--org", "example-team"]);
		expect(m[mode]).toHaveBeenCalledWith(
			{ draft: { content: "Reply briefly" } },
			{ org: "example-team" },
		);
		expect(m.output).toHaveBeenCalledWith(expect.any(Object), {
			format: "json",
		});
	},
);
it("rejects malformed and oversized files before spending", async () => {
	m.read.mockResolvedValue(Buffer.from("{"));
	await expect(run(["preview", "example.json"])).rejects.toThrow();
	m.read.mockResolvedValue(Buffer.alloc(512 * 1024 + 1));
	await expect(run(["preview", "example.json"])).rejects.toThrow(/512 KiB/);
	expect(m.preview).not.toHaveBeenCalled();
});

it("reads and saves response contracts without conflating CLI output format and response format", async () => {
	m.getResponseContract.mockResolvedValue({
		responseContract: { format: "AUTO" },
	});
	await run(["response", "example-prompt", "--org", "example-team"]);
	expect(m.getResponseContract).toHaveBeenCalledWith("example-prompt", {
		org: "example-team",
	});
	m.read.mockResolvedValue('{"format":"XML"}');
	m.setResponseContract.mockResolvedValue({ versionId: "example-v2" });
	await run([
		"response",
		"example-prompt",
		"--file",
		"contract.json",
		"--org",
		"example-team",
	]);
	expect(m.setResponseContract).toHaveBeenCalledWith(
		"example-prompt",
		{ format: "XML" },
		{ org: "example-team" },
	);
});
it("sets a failure exit code when a completed preview fails response validation", async () => {
	const prior = process.exitCode;
	try {
		m.preview.mockResolvedValue({
			output: "invalid",
			validation: { status: "failed", issues: [] },
		});
		await run(["preview", "example.json"]);
		expect(process.exitCode).toBe(1);
		expect(m.output).toHaveBeenCalled();
	} finally {
		process.exitCode = prior;
	}
});
