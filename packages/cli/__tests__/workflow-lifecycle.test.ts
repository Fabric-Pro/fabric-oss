import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	publish: vi.fn(),
	unpublish: vi.fn(),
	pause: vi.fn(),
	resume: vi.fn(),
	rollback: vi.fn(),
	getSchedule: vi.fn(),
	configureSchedule: vi.fn(),
	listVersions: vi.fn(),
	output: vi.fn(),
	error: vi.fn((s: string) => {
		throw Error(s);
	}),
}));
vi.mock("../src/lib/client.js", () => ({
	getClient: () => ({ workflows: m }),
}));
vi.mock("../src/lib/context.js", () => ({
	resolveContext: (_p: unknown, org?: string) => ({
		type: "org",
		slug: org ?? "example-org",
	}),
}));
vi.mock("../src/lib/output.js", () => ({
	printOutput: m.output,
	printError: m.error,
	printSuccess: vi.fn(),
	printRecord: vi.fn(),
}));

import { buildWorkflowsCommand } from "../src/commands/workflows/index.js";

const run = (a: string[]) =>
	buildWorkflowsCommand().exitOverride().parseAsync(a, { from: "user" });
beforeEach(() => {
	vi.clearAllMocks();
	m.publish.mockResolvedValue({ success: true });
	m.pause.mockResolvedValue({
		workflowId: "example-workflow",
		status: "PAUSED",
	});
	m.resume.mockResolvedValue({
		workflowId: "example-workflow",
		status: "PUBLISHED",
	});
	m.unpublish.mockResolvedValue({
		workflowId: "example-workflow",
		success: true,
	});
});
it.each(["pause", "resume", "unpublish"] as const)(
	"propagates the chosen organization for %s",
	async (op) => {
		await run([op, "example-workflow", "--org", "example-team"]);
		expect(m[op]).toHaveBeenCalledWith("example-workflow", {
			org: "example-team",
		});
	},
);
it("publishes, lists versions and rolls back through the SDK", async () => {
	await run(["publish", "example-workflow", "--changelog", "Reviewed"]);
	expect(m.publish).toHaveBeenCalledWith(
		"example-workflow",
		{ changelog: "Reviewed", enableWebhook: undefined },
		{ org: "example-org" },
	);
	await run(["versions", "example-workflow", "--offset", "20"]);
	expect(m.listVersions).toHaveBeenCalledWith("example-workflow", {
		org: "example-org",
		limit: 20,
		offset: 20,
	});
	await run(["rollback", "example-workflow", "2"]);
	expect(m.rollback).toHaveBeenCalledWith("example-workflow", 2, {
		org: "example-org",
	});
});
it("saves a schedule draft without publishing", async () => {
	await run([
		"schedule",
		"set",
		"example-workflow",
		"--cron",
		"0 9 * * 1",
		"--timezone",
		"UTC",
	]);
	expect(m.configureSchedule).toHaveBeenCalledWith(
		"example-workflow",
		{ cron: "0 9 * * 1", timezone: "UTC" },
		{ org: "example-org" },
	);
	expect(m.publish).not.toHaveBeenCalled();
});
it("surfaces refused publication as a failure", async () => {
	m.publish.mockResolvedValue({ success: false });
	await expect(run(["publish", "example-workflow"])).rejects.toThrow(
		"Publication was refused",
	);
});
