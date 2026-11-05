import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	start: vi.fn(),
	get: vi.fn(),
	cancel: vi.fn(),
	output: vi.fn(),
	read: vi.fn(),
	error: vi.fn((message: string) => {
		throw new Error(message);
	}),
}));
vi.mock("node:fs/promises", () => ({ readFile: m.read }));
vi.mock("../src/lib/client.js", () => ({
	getClient: () => ({ agentPreviews: m }),
}));
vi.mock("../src/lib/context.js", () => ({
	resolveContext: (_project: unknown, org?: string) => ({
		type: "org",
		slug: org ?? "example-org",
	}),
}));
vi.mock("../src/lib/output.js", () => ({
	printOutput: m.output,
	printError: m.error,
}));

import { buildAgentPreviewsCommand } from "../src/commands/agents/previews.js";

const run = (args: string[]) =>
	buildAgentPreviewsCommand()
		.exitOverride()
		.parseAsync(args, { from: "user" });
beforeEach(() => {
	vi.clearAllMocks();
	for (const fn of [m.start, m.get, m.cancel]) {
		fn.mockResolvedValue({ status: "RUNNING" });
	}
});
describe("draft preview CLI", () => {
	it("passes a complete JSON draft request without manufacturing a key", async () => {
		const request = {
			draft: { instructions: "Use project context" },
			userMessage: "Summarize",
			idempotencyKey: "example-uuid",
		};
		m.read.mockResolvedValue(Buffer.from(JSON.stringify(request)));
		await run(["start", "example-request.json", "--org", "example-org"]);
		expect(m.start).toHaveBeenCalledWith(request, { org: "example-org" });
	});
	it.each(["get", "cancel"])(
		"pins %s to an optional explicit run",
		async (command) => {
			await run([command, "example-preview", "--run-id", "example-run"]);
			expect(m[command as "get"]).toHaveBeenCalledWith(
				"example-preview",
				{ org: "example-org", runId: "example-run" },
			);
		},
	);
	it("refuses oversized files before a network request", async () => {
		m.read.mockResolvedValue(Buffer.alloc(132000));
		await expect(run(["start", "example-request.json"])).rejects.toThrow(
			"128 KiB",
		);
		expect(m.start).not.toHaveBeenCalled();
	});
});
