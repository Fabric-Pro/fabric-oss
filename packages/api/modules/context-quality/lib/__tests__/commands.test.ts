import { contextQualitySourceRevision } from "@repo/rag/lib/context-quality";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../context-reader", async (importOriginal) => ({
	...(await importOriginal<typeof import("../context-reader")>()),
	readProjectContextSnapshot: mocks.read,
}));

import {
	ContextQualityInputError,
	evaluateProjectContext,
	inspectContextQualitySource,
} from "../commands";
import {
	ContextReadError,
	type ProjectContextReadInput,
	type ProjectContextSnapshot,
} from "../context-reader";

const actor = {
	organizationId: "org-example-alpha",
	projectId: "project-example-alpha",
	userId: "user-example-alpha",
};
const content = "Private example source: appointment cancellation policy.";
const revision = contextQualitySourceRevision(content);

function snapshot(
	sourceId = "source-example-alpha",
	text = content,
): ProjectContextSnapshot {
	return {
		sourceId,
		sourceKind: "project_context",
		projectId: actor.projectId,
		organizationId: actor.organizationId,
		title: "Example appointment policy",
		content: text,
		revision: contextQualitySourceRevision(text),
		byteLength: Buffer.byteLength(text, "utf8"),
		indexingExcluded: false,
		readMode: "direct",
	};
}

function input() {
	return {
		version: 1,
		sources: [
			{ sourceId: "source-example-alpha", expectedRevision: revision },
		],
		cases: [
			{
				id: "case-example-alpha",
				recordedAnswer: "Patients may cancel appointments online.",
				retrievedSourceIds: ["source-example-alpha"],
				citedSourceIds: ["source-example-alpha"],
				expectations: {
					expectedSourceIds: ["source-example-alpha"],
					requiredPhrases: ["cancel appointments online"],
					forbiddenPhrases: ["call a receptionist"],
				},
			},
		],
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.read.mockImplementation(async (read: ProjectContextReadInput) => {
		if (
			read.organizationId !== actor.organizationId ||
			read.projectId !== actor.projectId
		) {
			throw new ContextReadError("NOT_FOUND");
		}
		if (read.userId !== actor.userId) {
			throw new ContextReadError("FORBIDDEN");
		}
		const result = snapshot(read.sourceId);
		if (
			read.expectedRevision &&
			read.expectedRevision !== result.revision
		) {
			throw new ContextReadError("STALE_REVISION");
		}
		return result;
	});
});

describe("context quality shared commands", () => {
	it("inspects a source using the exact explicit actor, with no caller-selected backend", async () => {
		const result = await inspectContextQualitySource(
			actor,
			"source-example-alpha",
		);
		expect(result).toEqual(snapshot());
		expect(mocks.read).toHaveBeenCalledExactlyOnceWith({
			...actor,
			sourceId: "source-example-alpha",
		});
	});

	it("scores the real engine and rechecks every pin before releasing a report", async () => {
		const result = await evaluateProjectContext(actor, input());
		expect(result).toMatchObject({
			projectId: actor.projectId,
			organizationId: actor.organizationId,
			status: "passed",
			mode: "recorded-output",
			counts: { cases: 1, passed: 1, failed: 0 },
		});
		expect(result).not.toHaveProperty("userId");
		expect(mocks.read).toHaveBeenCalledTimes(2);
		for (const [read] of mocks.read.mock.calls) {
			expect(read).toEqual({
				...actor,
				sourceId: "source-example-alpha",
				expectedRevision: revision,
			});
		}
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(content);
		expect(serialized).not.toContain(input().cases[0].recordedAnswer);
		expect(serialized).not.toContain(
			input().cases[0].expectations.requiredPhrases[0],
		);
	});

	it("includes failed cases in the denominator and does not call a live target", async () => {
		const raw = input();
		raw.cases.push({
			...structuredClone(raw.cases[0]),
			id: "case-example-failed",
			recordedAnswer: "Please call a receptionist.",
		});
		const result = await evaluateProjectContext(actor, raw);
		expect(result).toMatchObject({
			status: "failed",
			counts: { cases: 2, passed: 1, failed: 1 },
		});
		expect(result.cases).toHaveLength(2);
	});

	it("does not report a source reference unavailable from selected snapshots as valid evidence", async () => {
		const raw = input();
		raw.cases[0].retrievedSourceIds = ["source-not-selected"];
		raw.cases[0].citedSourceIds = ["source-not-selected"];
		const result = await evaluateProjectContext(actor, raw);
		expect(result).toMatchObject({
			status: "failed",
			counts: { integrityFailures: 2 },
		});
		expect(
			mocks.read.mock.calls.every(
				([read]) => read.sourceId === "source-example-alpha",
			),
		).toBe(true);
	});

	it.each([
		[
			"other organization",
			{ ...actor, organizationId: "org-example-bravo" },
			"NOT_FOUND",
		],
		[
			"other project",
			{ ...actor, projectId: "project-example-bravo" },
			"NOT_FOUND",
		],
		[
			"revoked subject",
			{ ...actor, userId: "user-example-revoked" },
			"FORBIDDEN",
		],
	])("propagates the reader refusal for %s", async (_label, scope, code) => {
		await expect(
			evaluateProjectContext(scope, input()),
		).rejects.toMatchObject({ code });
		expect(mocks.read).toHaveBeenCalledTimes(1);
	});

	it.each(["FORBIDDEN", "NOT_FOUND", "STALE_REVISION"] as const)(
		"withholds the report when %s appears on the final source recheck",
		async (code) => {
			mocks.read
				.mockResolvedValueOnce(snapshot())
				.mockRejectedValueOnce(new ContextReadError(code));
			await expect(
				evaluateProjectContext(actor, input()),
			).rejects.toMatchObject({ code });
			expect(mocks.read).toHaveBeenCalledTimes(2);
		},
	);

	it("rechecks an earlier source after loading a later source", async () => {
		const raw = input();
		raw.sources.push({
			sourceId: "source-example-bravo",
			expectedRevision: revision,
		});
		mocks.read
			.mockResolvedValueOnce(snapshot())
			.mockResolvedValueOnce(snapshot("source-example-bravo"))
			.mockRejectedValueOnce(new ContextReadError("STALE_REVISION"));
		await expect(evaluateProjectContext(actor, raw)).rejects.toMatchObject({
			code: "STALE_REVISION",
		});
		expect(mocks.read.mock.calls.map(([read]) => read.sourceId)).toEqual([
			"source-example-alpha",
			"source-example-bravo",
			"source-example-alpha",
		]);
	});

	it("refuses an old inspection pin without scoring current bytes as the old source", async () => {
		const raw = input();
		raw.sources[0].expectedRevision = "0".repeat(64);
		await expect(evaluateProjectContext(actor, raw)).rejects.toMatchObject({
			code: "STALE_REVISION",
		});
	});

	it.each([
		[
			"client actor",
			(raw: ReturnType<typeof input>) => ({
				...raw,
				userId: "user-example-bravo",
			}),
		],
		[
			"client tenant",
			(raw: ReturnType<typeof input>) => ({
				...raw,
				organizationId: "org-example-bravo",
			}),
		],
		[
			"source bytes",
			(raw: ReturnType<typeof input>) => ({
				...raw,
				sources: [{ ...raw.sources[0], content: "client data" }],
			}),
		],
		[
			"provider host",
			(raw: ReturnType<typeof input>) => ({
				...raw,
				databricksWorkspaceOrigin: "https://example.com",
			}),
		],
		[
			"empty source list",
			(raw: ReturnType<typeof input>) => ({ ...raw, sources: [] }),
		],
		[
			"duplicate source",
			(raw: ReturnType<typeof input>) => ({
				...raw,
				sources: [...raw.sources, raw.sources[0]],
			}),
		],
		[
			"duplicate case identifier",
			(raw: ReturnType<typeof input>) => ({
				...raw,
				cases: [...raw.cases, structuredClone(raw.cases[0])],
			}),
		],
		[
			"duplicate retrieved reference",
			(raw: ReturnType<typeof input>) => ({
				...raw,
				cases: [
					{
						...raw.cases[0],
						retrievedSourceIds: [
							"source-example-alpha",
							"source-example-alpha",
						],
					},
				],
			}),
		],
		[
			"duplicate cited reference",
			(raw: ReturnType<typeof input>) => ({
				...raw,
				cases: [
					{
						...raw.cases[0],
						citedSourceIds: [
							"source-example-alpha",
							"source-example-alpha",
						],
					},
				],
			}),
		],
		[
			"duplicate expected reference",
			(raw: ReturnType<typeof input>) => ({
				...raw,
				cases: [
					{
						...raw.cases[0],
						expectations: {
							...raw.cases[0].expectations,
							expectedSourceIds: [
								"source-example-alpha",
								"source-example-alpha",
							],
						},
					},
				],
			}),
		],
		[
			"duplicate required phrase",
			(raw: ReturnType<typeof input>) => ({
				...raw,
				cases: [
					{
						...raw.cases[0],
						expectations: {
							...raw.cases[0].expectations,
							requiredPhrases: ["online", "online"],
						},
					},
				],
			}),
		],
		[
			"duplicate forbidden phrase",
			(raw: ReturnType<typeof input>) => ({
				...raw,
				cases: [
					{
						...raw.cases[0],
						expectations: {
							...raw.cases[0].expectations,
							forbiddenPhrases: ["phone", "phone"],
						},
					},
				],
			}),
		],
		[
			"empty case expectations",
			(raw: ReturnType<typeof input>) => ({
				...raw,
				cases: [
					{
						...raw.cases[0],
						expectations: {
							expectedSourceIds: [],
							requiredPhrases: [],
							forbiddenPhrases: [],
						},
					},
				],
			}),
		],
		[
			"oversized whitespace-padded identifier",
			(raw: ReturnType<typeof input>) => ({
				...raw,
				sources: [
					{
						...raw.sources[0],
						sourceId: `${" ".repeat(129)}source-example-alpha`,
					},
				],
			}),
		],
		[
			"unknown version",
			(raw: ReturnType<typeof input>) => ({ ...raw, version: 2 }),
		],
		[
			"invalid pin",
			(raw: ReturnType<typeof input>) => ({
				...raw,
				sources: [{ ...raw.sources[0], expectedRevision: "not-a-pin" }],
			}),
		],
	])("rejects %s before source access", async (_label, mutate) => {
		await expect(
			evaluateProjectContext(actor, mutate(input())),
		).rejects.toBeInstanceOf(ContextQualityInputError);
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it("rejects invalid case references before reads without echoing recorded answers on errors", async () => {
		const raw = input();
		raw.cases[0].citedSourceIds.push("source-example-alpha");
		try {
			await evaluateProjectContext(actor, raw);
			expect.fail("Expected duplicate citation to be rejected");
		} catch (error) {
			expect(error).toBeInstanceOf(ContextQualityInputError);
			expect(String(error)).not.toContain(raw.cases[0].recordedAnswer);
			expect(String(error)).not.toContain(content);
		}
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it("bounds the cumulative source bytes before loading or scoring the full dataset", async () => {
		const raw = input();
		raw.sources.push({
			sourceId: "source-example-bravo",
			expectedRevision: revision,
		});
		mocks.read.mockImplementation(async (read: ProjectContextReadInput) =>
			snapshot(read.sourceId, "x".repeat(96 * 1024)),
		);
		await expect(evaluateProjectContext(actor, raw)).rejects.toMatchObject({
			code: "TOO_LARGE",
		});
		expect(mocks.read).toHaveBeenCalledTimes(2);
	});

	it("enforces serialized snapshot limits in addition to source-byte sums", async () => {
		const raw = input();
		mocks.read.mockResolvedValue(
			snapshot("source-example-alpha", "\u0001".repeat(24 * 1024)),
		);
		await expect(evaluateProjectContext(actor, raw)).rejects.toMatchObject({
			code: "TOO_LARGE",
		});
	});
});
