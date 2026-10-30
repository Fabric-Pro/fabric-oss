/**
 * Advisor Stop during the project_rag_query tool's retrieval.
 *
 * `retrieveProjectContextsActivity` caught every failure and returned an
 * empty context, so a stopped chat turn's refused or aborted embedding read
 * as "no relevant content" and the turn went on. With `options.turnScope`
 * (the trailing argument the orchestrator passes) the retrieval runs inside
 * the turn's dispatch guard and a stop leaves the activity; the other
 * callers, which pass no options, keep the empty result.
 */

import { getDispatchGuard } from "@repo/utils/dispatch-guard";
import { log } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { MockActivityEnvironment } from "@temporalio/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	retrieveProjectContexts: vi.fn(),
	contextMetaHeader: vi.fn(() => ""),
}));

vi.mock("@repo/database", () => ({
	checkConversationTurnDispatchable: vi.fn(),
	db: {},
	getProjectContextAvailability: vi.fn(),
	getProjectRepositoryRoles: vi.fn(),
	parseRepoUrl: vi.fn(),
	tenantWhere: vi.fn(),
}));

vi.mock("@repo/rag", async () => ({
	...(await import(
		"@repo/rag/lib/project-contexts/project-context-passages"
	)),
	retrieveProjectContexts: mocks.retrieveProjectContexts,
	contextMetaHeader: mocks.contextMetaHeader,
}));

import type { SecondaryUsageInput } from "../../workflows/orchestrator/usage-attribution";
import { retrieveProjectContextsActivity } from "../project-metadata";

const TURN_SCOPE = {
	turnId: "turn-example-1",
	executionId: "orch-example-1",
	userId: "user-example-1",
	organizationId: "org-example-1",
};

function turnStopped() {
	return ApplicationFailure.create({
		type: "TurnNotDispatchable",
		message: "Turn turn-example-1 may not make another model request",
		nonRetryable: true,
		details: [{ reason: "cancelled" }],
	});
}

/** Runs the activity in an activity context (its logger needs one). */
function retrieve(
	options?: SecondaryUsageInput & {
		turnScope?: typeof TURN_SCOPE;
		maxPassageChars?: number;
	},
) {
	return new MockActivityEnvironment().run(
		retrieveProjectContextsActivity,
		"what is the launch date",
		"project-1",
		TURN_SCOPE.userId,
		TURN_SCOPE.organizationId,
		5,
		options,
	) as Promise<{ context: string; chunkCount: number }>;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.contextMetaHeader.mockReturnValue("");
});

describe("retrieveProjectContextsActivity", () => {
	it("keeps accounting origin independent of the retrieval project", async () => {
		mocks.retrieveProjectContexts.mockResolvedValue([]);
		const usageOrigin = {
			conversationId: "turn-conversation",
			projectId: "origin-project",
			frameId: "origin-frame",
			featureKey: "chat-agent" as const,
		};
		await retrieve({ usageOrigin });
		expect(mocks.retrieveProjectContexts).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "project-1",
				userId: TURN_SCOPE.userId,
				organizationId: TURN_SCOPE.organizationId,
				usageOrigin,
				diversify: true,
				skipRerank: true,
			}),
		);
	});

	it("rethrows a stop in a chat turn", async () => {
		const stop = turnStopped();
		mocks.retrieveProjectContexts.mockRejectedValue(stop);

		await expect(retrieve({ turnScope: TURN_SCOPE })).rejects.toBe(stop);
	});

	it("rethrows a stop @repo/rag wrapped with its cause", async () => {
		const stop = turnStopped();
		mocks.retrieveProjectContexts.mockRejectedValue(
			new Error("Failed to retrieve project contexts: stopped", {
				cause: stop,
			}),
		);

		await expect(retrieve({ turnScope: TURN_SCOPE })).rejects.toBe(stop);
	});

	it("runs the retrieval inside the turn's dispatch guard", async () => {
		let guardKey: string | undefined;
		mocks.retrieveProjectContexts.mockImplementation(async () => {
			guardKey = getDispatchGuard()?.key;
			return [];
		});

		await retrieve({ turnScope: TURN_SCOPE });

		expect(guardKey).toBeDefined();
	});

	it("keeps only the opening of each passage when asked to, cut at a line break", async () => {
		const long = `First line of the plan.\n${"x".repeat(80)}\n${"y".repeat(400)}`;
		mocks.retrieveProjectContexts.mockResolvedValue([
			{ content: long, filename: "plan.md" },
			{ content: "Short note.", filename: "note.md" },
		]);

		const capped = await retrieve({ maxPassageChars: 200 });
		const whole = await retrieve();

		expect(capped).toEqual({
			context: expect.stringContaining(
				`First line of the plan.\n${"x".repeat(80)}\n\n---\n\n### From: note.md\nShort note.`,
			),
			chunkCount: 2,
		});
		expect(capped).toEqual({
			context: expect.not.stringContaining("yyyy"),
			chunkCount: 2,
		});
		expect(whole).toEqual({
			context: expect.stringContaining("y".repeat(400)),
			chunkCount: 2,
		});
	});

	it("keeps the empty result for a caller with no turn", async () => {
		mocks.retrieveProjectContexts.mockRejectedValue(turnStopped());

		await expect(retrieve()).resolves.toEqual({
			context: "",
			chunkCount: 0,
		});
	});
});

describe("compact project knowledge results", () => {
	it("returns matched passages with eight large sources inside the serialized budget", async () => {
		const sources = Array.from({ length: 8 }, (_, i) => ({
			id: `source-${i}`,
			type: "TEXT",
			filename: `plan-${i}.md`,
			content: "WHOLE BODY ".repeat(2000),
			matchedPassages: [
				{
					content: `BEST-${i} ${"matching requirement\n".repeat(150)}`,
					score: 1 - i / 100,
				},
				{
					content: `EXTRA-${i} ${"supporting detail\n".repeat(60)}`,
					score: 0.5 - i / 100,
				},
			],
		}));
		mocks.retrieveProjectContexts.mockResolvedValue(sources);
		const result = await retrieve();
		expect(result.context).not.toContain("WHOLE BODY");
		expect(JSON.stringify(result).length).toBeLessThanOrEqual(10000);
		for (let i = 0; i < 8; i++) {
			expect(result.context).toContain(`BEST-${i}`);
			expect(result.context).toContain(`source-${i}`);
		}
		expect(result.context).toContain("fabric_get_project_source");
		expect(mocks.retrieveProjectContexts).toHaveBeenCalledWith(
			expect.objectContaining({ includeMatchedPassages: true }),
		);
	});
	it("fills spare budget with an older-point body and names its omission", async () => {
		mocks.retrieveProjectContexts.mockResolvedValue([
			{
				id: "source-old",
				type: "TEXT",
				filename: "old.md",
				content: `${"Opening line\n".repeat(1000)}BODY TAIL`,
				matchedPassages: [],
			},
		]);
		const result = await retrieve();
		expect(result.context).toContain("Opening line");
		expect(result.context).not.toContain("BODY TAIL");
		expect(result.context).toContain("Content omitted");
		expect(result.context).toContain(
			'fabric_get_project_source({"source":"source-old"})',
		);
		expect(JSON.stringify(result).length).toBeGreaterThanOrEqual(9995);
		expect(JSON.stringify(result).length).toBeLessThanOrEqual(10000);
	});
	it("preserves Parlume body heads even when matched passages are available", async () => {
		mocks.retrieveProjectContexts.mockResolvedValue([
			{
				id: "source-1",
				content: `Original body\n${"x".repeat(300)}`,
				filename: "plan.md",
				matchedPassages: [{ content: "MATCH ONLY", score: 1 }],
			},
		]);
		const result = await retrieve({ maxPassageChars: 100 });
		expect(result.context).toContain(`Original body\n${"x".repeat(86)}`);
		expect(result.context).not.toContain("MATCH ONLY");
		expect(
			mocks.retrieveProjectContexts.mock.calls[0][0]
				.includeMatchedPassages,
		).not.toBe(true);
	});
	it("budgets injected summaries and does not advertise synthetic ids as readable sources", async () => {
		mocks.retrieveProjectContexts.mockResolvedValue([
			{
				id: "summary-1",
				type: "PROJECT_SUMMARY",
				metadata: { isSummary: true },
				content: "Summary detail\n".repeat(2000),
				sourceTitle: "Compressed project history",
			},
			{
				id: "bundle-1",
				type: "SLACK_CHANNEL",
				metadata: {
					conversationBundleId: "bundle-1",
					parentContextId: "parent-channel",
				},
				content: "Bundle head",
				matchedPassages: [{ content: "Bundle match", score: 0.9 }],
			},
			{
				id: "page-1",
				type: "LINK",
				metadata: {
					parentContextId: "parent-crawl",
					pageUrl: "https://example.com/plan",
				},
				content: "Indexed page",
				matchedPassages: [{ content: "Page match", score: 0.8 }],
			},
		]);
		const result = await retrieve();
		expect(JSON.stringify(result).length).toBeLessThanOrEqual(10000);
		expect(result.context).toContain("Summary detail");
		expect(result.context).toContain("Bundle match");
		expect(result.context).toContain(
			'fabric_get_project_source({"source":"parent-channel"})',
		);
		expect(result.context).toContain(
			'fabric_get_project_source({"source":"parent-crawl"})',
		);
		expect(result.context.split("\n\n---\n\n")[0]).not.toContain(
			"fabric_get_project_source",
		);
	});
});

it("retains source naming and metadata and adds further passages by relevance", async () => {
	mocks.contextMetaHeader.mockReturnValue(
		"[Source type: Requirements]\n[Source guidance: Focus on launch]\n",
	);
	mocks.retrieveProjectContexts.mockResolvedValue([
		{
			id: "source-a",
			type: "TEXT",
			sourcePath: "docs/plan.md",
			filename: "wrong.md",
			sourceTitle: "Wrong title",
			content: "Whole body omitted",
			matchedPassages: [
				{ content: "Best A", score: 0.99 },
				{ content: "Lower detail ".repeat(800), score: 0.6 },
			],
		},
		{
			id: "source-b",
			type: "TEXT",
			sourceTitle: "Launch notes",
			content: "Whole body omitted",
			matchedPassages: [
				{ content: "Best B", score: 0.9 },
				{ content: "Higher detail ".repeat(600), score: 0.8 },
			],
		},
	]);
	const result = await retrieve();
	expect(result.context).toContain("### From: docs/plan.md");
	expect(result.context).not.toContain("wrong.md");
	expect(result.context).toContain(
		"[Source type: Requirements]\n[Source guidance: Focus on launch]",
	);
	expect(result.context).toContain("Best A");
	expect(result.context).toContain("Best B");
	expect(result.context).toContain("Higher detail ".repeat(600).trimEnd());
	expect(result.context).not.toContain("Lower detail ".repeat(800));
	expect(JSON.stringify(result).length).toBeLessThanOrEqual(10000);
});

it("logs a successful compact project retrieval", async () => {
	const info = vi.spyOn(log, "info");
	mocks.retrieveProjectContexts.mockResolvedValue([
		{
			id: "source-log",
			type: "TEXT",
			score: 1,
			content: "Head",
			matchedPassages: [{ content: "Match", score: 1 }],
		},
	]);
	try {
		await retrieve();
		expect(info).toHaveBeenCalledWith(
			"[ProjectRAG] Retrieved project context",
			expect.objectContaining({ resultCount: 1, projectId: "project-1" }),
		);
	} finally {
		info.mockRestore();
	}
});
