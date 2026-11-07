import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	getClient: vi.fn(),
	output: vi.fn(),
	error: vi.fn(),
	list: vi.fn(),
	record: vi.fn(),
}));

vi.mock("../src/lib/client.js", () => ({ getClient: m.getClient }));
vi.mock("../src/lib/context.js", () => ({
	resolveContext: () => ({ type: "org", slug: "example-org" }),
}));
vi.mock("../src/lib/output.js", () => ({
	printOutput: m.output,
	printError: m.error,
}));

import { buildDashboardCommand } from "../src/commands/dashboard/index.js";

function run(args: string[]) {
	return new Command()
		.exitOverride()
		.addCommand(buildDashboardCommand())
		.parseAsync(args, { from: "user" });
}

beforeEach(() => {
	vi.clearAllMocks();
	m.getClient.mockReturnValue({
		dashboard: {
			listCuratedFeedback: m.list,
			recordCuratedFeedback: m.record,
		},
	});
	m.list.mockResolvedValue({ preferences: [] });
	m.record.mockResolvedValue({ preference: { cardKey: "project:one" } });
});

describe("dashboard CLI", () => {
	it("lists feedback in the selected organization", async () => {
		await run(["dashboard", "curated", "--format", "json"]);
		expect(m.list).toHaveBeenCalledWith({ org: "example-org" });
	});

	it("records stable-key feedback without rewriting the action", async () => {
		await run(["dashboard", "feedback", "review:run-1", "pin"]);
		expect(m.record).toHaveBeenCalledWith(
			{ cardKey: "review:run-1", action: "pin" },
			{ org: "example-org" },
		);
	});

	it("rejects an unknown action before calling the API", async () => {
		await run(["dashboard", "feedback", "review:run-1", "hide"]);
		expect(m.record).not.toHaveBeenCalled();
		expect(m.error).toHaveBeenCalled();
	});
});
