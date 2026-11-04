import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SavedEvaluationError } from "../../saved-contracts";
import {
	type AgentResultRecord,
	createAgentResultCommands,
} from "../agent-result";

const actor = {
	organizationId: "example-org",
	projectId: "example-project",
	userId: "example-user",
};
const answer = "🧵 Release is ready. The blocker owner is Example Team.";
const row: AgentResultRecord = {
	executionId: "example-execution",
	instanceId: "example-instance",
	projectId: actor.projectId,
	workflowId: "example-workflow",
	runId: "example-native-run",
	status: "COMPLETED",
	executionStateSource: "temporal",
	completedAt: "2026-11-03T12:00:00.000Z",
	output: { response: answer },
};
const load =
	vi.fn<
		(principal: typeof actor, id: string) => Promise<AgentResultRecord>
	>();
const commands = createAgentResultCommands(load);
const inspected = () =>
	commands.inspect(actor, { executionId: row.executionId });
async function input() {
	return {
		executionId: row.executionId,
		expectedRevision: (await inspected()).revision,
		requiredPhrases: ["Release is ready"],
		forbiddenPhrases: ["No owner"],
	};
}
beforeEach(() => {
	vi.resetAllMocks();
	load.mockResolvedValue({ ...row });
});

describe("actual recorded agent-result checks", () => {
	it("safely refuses a combined scoring packet exceeding the shared byte budget", async () => {
		load.mockResolvedValue({
			...row,
			output: "A" + "\u0000".repeat(16000),
		});
		const request = {
			...(await input()),
			requiredPhrases: Array.from(
				{ length: 20 },
				(_, i) => `${i}${"\u0000".repeat(500)}`,
			),
			forbiddenPhrases: Array.from(
				{ length: 20 },
				(_, i) => `${i}${"\u0001".repeat(500)}`,
			),
		};
		await expect(commands.evaluate(actor, request)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});
	it.each([
		answer,
		{ response: answer },
		{ text: answer },
		{ content: answer },
	])(
		"inspects exactly the displayable result and hashes its UTF-8 bytes",
		async (output) => {
			load.mockResolvedValue({ ...row, output });
			const result = await inspected();
			expect(result.recordedAnswer).toBe(answer);
			expect(result.outputHash).toBe(
				createHash("sha256").update(answer, "utf8").digest("hex"),
			);
			expect(result).toMatchObject({
				executionId: row.executionId,
				runId: row.runId,
				workflowId: row.workflowId,
				projectId: actor.projectId,
				instanceId: row.instanceId,
				mode: "recorded-agent-result",
				executionStateSource: "temporal",
				targetInvoked: false,
				historicalReplay: false,
				retrievalEvidence: "not-evaluated",
				saved: false,
			});
			expect(result.revision).toMatch(/^[a-f0-9]{64}$/);
			expect(load).toHaveBeenCalledExactlyOnceWith(
				actor,
				row.executionId,
			);
		},
	);
	it("keeps archived evidence labeled as a database record", async () => {
		load.mockResolvedValue({
			...row,
			executionStateSource: "database",
			runId: null,
			completedAt: null,
		});
		expect(await inspected()).toMatchObject({
			executionStateSource: "database",
			runId: null,
			completedAt: null,
			historicalReplay: false,
		});
	});
	it("scores the server-loaded answer without inventing retrieval or citation evidence", async () => {
		const request = await input();
		load.mockClear();
		const report = await commands.evaluate(actor, request);
		expect(report.status).toBe("passed");
		expect(report.origin.recordedAnswer).toBe(answer);
		expect(report.sources).toEqual([]);
		expect(report.cases[0].retrieval).toEqual({
			precision: null,
			recall: null,
		});
		expect(report.cases[0].citations).toEqual({
			precision: null,
			recall: null,
		});
		expect(report.cases[0].checks.map((check) => check.id)).not.toContain(
			"expected-sources-cited",
		);
		expect(report.expectationResults).toEqual([
			{ kind: "required", phrase: "Release is ready", passed: true },
			{ kind: "forbidden", phrase: "No owner", passed: true },
		]);
		expect(load).toHaveBeenCalledTimes(2);
	});
	it("reports unmet required and present forbidden phrases as failed evidence", async () => {
		const request = await input();
		const report = await commands.evaluate(actor, {
			...request,
			requiredPhrases: ["Approved by every reviewer"],
			forbiddenPhrases: ["blocker"],
		});
		expect(report.status).toBe("failed");
		expect(report.counts).toMatchObject({
			passed: 0,
			failed: 1,
			qualityFailures: 2,
		});
		expect(
			report.expectationResults.every((entry) => entry.passed === false),
		).toBe(true);
	});
	it.each([
		{ recordedAnswer: "Fabricated success" },
		{ organizationId: "example-other-org" },
		{ userId: "example-other-user" },
		{ citedSourceIds: ["example-source"] },
		{ retrievedSourceIds: ["example-source"] },
	])(
		"refuses caller-supplied answer, authority or source evidence",
		async (extra) => {
			const request = await input();
			load.mockClear();
			await expect(
				commands.evaluate(actor, { ...request, ...extra }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(load).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ runId: "example-other-native-run" },
		{ workflowId: "example-other-workflow" },
		{ instanceId: "example-other-instance" },
		{ executionStateSource: "database" as const },
		{ completedAt: "2026-11-03T12:01:00.000Z" },
		{ output: `${answer} Changed.` },
	])(
		"refuses a changed output or execution identity against an inspected pin",
		async (change) => {
			const request = await input();
			load.mockResolvedValue({ ...row, ...change });
			await expect(
				commands.evaluate(actor, request),
			).rejects.toMatchObject({ code: "CONFLICT" });
		},
	);
	it.each([
		"RUNNING",
		"UNKNOWN",
		"FAILED",
		"CANCELLED",
		"TIMED_OUT",
		"PENDING",
	])("refuses %s as a completed result", async (status) => {
		load.mockResolvedValue({ ...row, status });
		await expect(inspected()).rejects.toMatchObject({ code: "CONFLICT" });
	});
	it.each([
		null,
		{},
		[],
		"",
		" \n\t",
		{ toolCalls: [{ result: "Success" }] },
		{ progress: "Success" },
		"x".repeat(16_385),
	])(
		"does not fabricate or shorten an unsupported, empty or oversized answer",
		async (output) => {
			load.mockResolvedValue({ ...row, output });
			await expect(inspected()).rejects.toMatchObject({
				code: "PRECONDITION_FAILED",
			});
		},
	);
	it.each([
		{ executionId: "example-other-execution" },
		{ projectId: "example-other-project" },
	])("refuses mismatched loaded identity", async (change) => {
		load.mockResolvedValue({ ...row, ...change });
		await expect(inspected()).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("discards a report when access is revoked during scoring", async () => {
		const request = await input();
		load.mockReset()
			.mockResolvedValueOnce(row)
			.mockRejectedValueOnce(
				new SavedEvaluationError(
					"FORBIDDEN",
					"Current access required.",
				),
			);
		await expect(commands.evaluate(actor, request)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
	it.each([
		{ output: `${answer} Changed.` },
		{ runId: "example-replacement-run" },
		{ status: "RUNNING" },
	])(
		"discards a report when the source changes before release",
		async (change) => {
			const request = await input();
			load.mockReset()
				.mockResolvedValueOnce(row)
				.mockResolvedValueOnce({ ...row, ...change });
			await expect(
				commands.evaluate(actor, request),
			).rejects.toMatchObject({ code: "CONFLICT" });
		},
	);
	it.each([
		{ requiredPhrases: [], forbiddenPhrases: [] },
		{ requiredPhrases: [" "] },
		{ requiredPhrases: ["x".repeat(513)] },
		{
			forbiddenPhrases: Array.from(
				{ length: 21 },
				(_, i) => `example-${i}`,
			),
		},
		{ expectedRevision: "not-a-revision" },
	])(
		"refuses unbounded or missing expectations before loading the run",
		async (change) => {
			const request = await input();
			load.mockClear();
			await expect(
				commands.evaluate(actor, { ...request, ...change }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(load).not.toHaveBeenCalled();
		},
	);
});
