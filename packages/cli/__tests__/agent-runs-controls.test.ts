import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	list: vi.fn(),
	search: vi.fn(),
	get: vi.fn(),
	cancel: vi.fn(),
	getSchedule: vi.fn(),
	setSchedule: vi.fn(),
	output: vi.fn(),
	error: vi.fn((message: string, code: number) => {
		throw Object.assign(new Error(message), { code });
	}),
}));
vi.mock("../src/lib/client.js", () => ({
	getClient: () => ({ agentRuns: m }),
}));
vi.mock("../src/lib/context.js", () => ({
	resolveContext: (_project: unknown, org: string | undefined) => ({
		type: "org",
		slug: org ?? "example-org",
	}),
}));
vi.mock("../src/lib/output.js", () => ({
	printOutput: m.output,
	printError: m.error,
}));

import { buildAgentRunsCommand } from "../src/commands/agents/runs.js";

const run = (args: string[]) =>
	buildAgentRunsCommand().exitOverride().parseAsync(args, { from: "user" });
beforeEach(() => {
	vi.resetAllMocks();
	for (const fn of [
		m.search,
		m.list,
		m.get,
		m.cancel,
		m.getSchedule,
		m.setSchedule,
	]) {
		fn.mockResolvedValue({ status: "RUNNING" });
	}
});
describe("CLI saved-agent controls", () => {
	it("lists bounded executions with explicit org", async () => {
		await run([
			"list",
			"example-instance",
			"--org",
			"example-org",
			"--limit",
			"5",
		]);
		expect(m.list).toHaveBeenCalledWith("example-instance", {
			org: "example-org",
			limit: 5,
		});
	});
	it.each([
		["get", "get"],
		["cancel", "cancel"],
		["schedule", "getSchedule"],
	])(
		"%s shares SDK result without fabricating status",
		async (command, method) => {
			await run([command, "example-row"]);
			expect(m[method as "get"]).toHaveBeenCalledWith("example-row", {
				org: "example-org",
			});
			expect(m.output).toHaveBeenCalledWith(
				{ status: "RUNNING" },
				{ format: "json" },
			);
		},
	);
	it("saves explicit cron/timezone/message and pause flag", async () => {
		await run([
			"schedule-set",
			"example-instance",
			"--cron",
			"0 9 * * *",
			"--timezone",
			"UTC",
			"--message",
			"Report progress",
			"--no-enabled",
		]);
		expect(m.setSchedule).toHaveBeenCalledWith(
			"example-instance",
			{
				cronExpression: "0 9 * * *",
				timezone: "UTC",
				input: { message: "Report progress" },
				enabled: false,
			},
			{ org: "example-org" },
		);
	});
	it("rejects unbounded limit before network I/O", async () => {
		await expect(
			run(["list", "example-instance", "--limit", "51"]),
		).rejects.toMatchObject({ code: 2 });
		expect(m.list).not.toHaveBeenCalled();
	});
	it("makes only one cancellation call after an unresolved acknowledgement", async () => {
		m.cancel.mockRejectedValue(new Error("Network acknowledgement lost"));
		await expect(run(["cancel", "example-row"])).rejects.toMatchObject({
			code: 1,
		});
		expect(m.cancel).toHaveBeenCalledOnce();
	});
});

describe("CLI paged agent history", () => {
	it("forwards scoped filters and continuation through the SDK", async () => {
		await run([
			"search",
			"--instance",
			"example-instance",
			"--status",
			"FAILED",
			"--trigger",
			"SCHEDULE",
			"--from",
			"2026-01-01T00:00:00Z",
			"--to",
			"2026-02-01T00:00:00Z",
			"--query",
			"Report risk",
			"--cursor",
			"opaque_cursor",
			"--limit",
			"10",
		]);
		expect(m.search).toHaveBeenCalledWith({
			org: "example-org",
			instanceId: "example-instance",
			status: "FAILED",
			triggerType: "SCHEDULE",
			from: "2026-01-01T00:00:00Z",
			to: "2026-02-01T00:00:00Z",
			query: "Report risk",
			cursor: "opaque_cursor",
			limit: 10,
		});
	});
	it("defaults to a bounded page across all authorized saved agents", async () => {
		await run(["search"]);
		expect(m.search).toHaveBeenCalledWith(
			expect.objectContaining({ org: "example-org", limit: 25 }),
		);
	});
	it.each([
		["--limit", "1000"],
		["--status", "RUNNING"],
		["--trigger", "INVALID"],
		["--from", "yesterday"],
		["--cursor", "invalid!"],
		["--query", "x".repeat(201)],
		["--from", "2026-02-01T00:00:00Z", "--to", "2026-01-01T00:00:00Z"],
	])(
		"rejects invalid history filters before network I/O: %j",
		async (...args) => {
			await expect(run(["search", ...args])).rejects.toMatchObject({
				code: 2,
			});
			expect(m.search).not.toHaveBeenCalled();
		},
	);
});

it.each(["example-v1", null])(
	"prints current and original version IDs from the shared history DTO unchanged (%s)",
	async (originalInstanceId) => {
		const history = {
			executions: [
				{
					id: "example-run",
					instanceId: "example-v2",
					executionInstanceId: originalInstanceId,
					agentName: "Current delivery reporter",
					task: "Report progress",
					status: "COMPLETED",
					lastRecordedStatus: "COMPLETED",
					queuedAt: "2026-01-01T09:00:00Z",
					createdAt: "2026-01-01T09:00:01Z",
					completedAt: "2026-01-01T09:00:04Z",
					duration: 3000,
					triggerType: "MANUAL",
				},
			],
			nextCursor: null,
		};
		m.search.mockResolvedValue(history);
		await run(["search"]);
		expect(m.output).toHaveBeenCalledWith(history, { format: "json" });
	},
);
