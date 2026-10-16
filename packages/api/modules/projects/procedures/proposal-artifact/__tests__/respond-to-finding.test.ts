/**
 * `projects.proposalArtifact.respondToFinding` (Fizzy #2946): a member
 * confirms or answers a finding. The answer is keyed by the finding's stable
 * key and records the current prose hash of its section; a submit on a run
 * the tab no longer shows carries over only within the same prose and
 * lineage; a lost race answers stale with the answer saved meanwhile.
 *
 * Access is covered in `access.test.ts`. The response store is the
 * harness's in-memory compare-and-swap, so an answer can be written and then
 * read back through `getAnalysis`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () =>
	(await import("./proposal-artifact-harness")).databaseModule(),
);
vi.mock("../../../../../orpc/procedures", async () =>
	(await import("./proposal-artifact-harness")).proceduresModule(),
);

import { PROPOSAL_FINDING_RESPONSE_TEXT_MAX_LENGTH } from "@repo/database";
import {
	buildSectionMap,
	DOCUMENT_SECTION_KEY,
	documentProseHash,
} from "@repo/utils/proposal-artifact/section-hash";
import { assertProjectPermission } from "../../../../../orpc/middleware/require-permission";
import { clearFindingResponseProcedure } from "../clear-finding-response";
import { getProposalAnalysisProcedure } from "../get-analysis";
import {
	FINDING_NOT_KEYED_CODE,
	respondToFindingProcedure,
	VERSION_AND_RESPONSE_ID_TOGETHER_CODE,
} from "../respond-to-finding";
import {
	auditRows,
	call,
	DOC_A,
	DOC_A2,
	inputRefusal,
	inputSchema,
	mocks,
	ORG_A,
	ORG_B,
	PROJECT_A,
	PROPOSAL_BODY,
	refusal,
	resetMocks,
	resetWorld,
	USER_NAMES,
	USERS,
	usePermissionCheck,
	type WorldFinding,
	type WorldRun,
	world,
} from "./proposal-artifact-harness";

usePermissionCheck(assertProjectPermission);

const MAP = buildSectionMap(PROPOSAL_BODY);
const SCOPE = MAP.sections.find(
	(section) => section.headingText === "Scope",
) as (typeof MAP.sections)[number];
/** A key in the analysis workflow's format: key version, colon, 32 hex. */
const KEY = "k1:5c0a3e7d9b1f24c68e0d7a3b5f9c1e24";
const ANSWER = "The client's team owns the migration.";

const T0 = new Date("2026-10-10T10:00:00.000Z");
const minutesAfter = (minutes: number) =>
	new Date(T0.getTime() + minutes * 60_000);

function storedFinding(overrides: Partial<WorldFinding> = {}): WorldFinding {
	return {
		id: "finding-1",
		title: "The migration has no owner",
		stableKey: KEY,
		sectionKey: SCOPE.key,
		sectionHash: SCOPE.proseHash,
		...overrides,
	};
}

/** A stored run of document A, describing the world's body by default. */
function storeRun(id: string, overrides: Partial<WorldRun> = {}): WorldRun {
	const run: WorldRun = {
		id,
		documentId: DOC_A,
		organizationId: ORG_A,
		proseHash: MAP.documentProseHash,
		sourceRunId: null,
		findings: [storedFinding({ id: `${id}-finding` })],
		...overrides,
	};
	world.runs.set(id, run);
	return run;
}

/** Have the read show `run`, as the query returns it. */
function show(run: WorldRun, createdAt: Date = T0) {
	mocks.getAnalysisForCurrentContent.mockResolvedValue({
		run: {
			id: run.id,
			documentId: run.documentId,
			projectId: PROJECT_A,
			organizationId: run.organizationId,
			runKey: `run-key-${run.id}`,
			status: "COMPLETE",
			kind: run.sourceRunId ? "RERUN" : "GENERATION",
			sourceRunId: run.sourceRunId,
			contentHash: "content-hash",
			proseHash: run.proseHash,
			documentVersion: 4,
			contextCount: 2,
			promptVersionId: "prompt-version-1",
			model: "example-model",
			errorCode: null,
			errorMessage: null,
			startedAt: createdAt,
			completedAt: createdAt,
			createdAt,
			updatedAt: createdAt,
			findings: run.findings.map((entry, position) => ({
				id: entry.id,
				severity: "IMPORTANT",
				type: "SCOPE",
				title: entry.title,
				detail: "The scope leaves the data migration unowned.",
				recommendation: null,
				sectionHeading: "Scope",
				position,
				stableKey: entry.stableKey,
				sectionKey: entry.sectionKey,
				sectionHash: entry.sectionHash,
				sourceRefs: [],
				foldedTitles: [],
			})),
			sourceManifest: null,
		},
		isStale: false,
		newerRun: null,
	});
}

function setBody(content: string) {
	const document = world.documents.get(DOC_A);
	world.documents.set(DOC_A, {
		...(document as NonNullable<typeof document>),
		content,
	});
}

type Respond = Record<string, unknown> & {
	outcome: "written" | "stale";
};

function respond(
	overrides: Record<string, unknown> = {},
	userId: string = USERS.editor,
) {
	return call(
		respondToFindingProcedure,
		{
			projectId: PROJECT_A,
			documentId: DOC_A,
			runId: "run-1",
			findingId: "run-1-finding",
			kind: "RESPONDED",
			text: ANSWER,
			...overrides,
		},
		userId,
	) as Promise<Respond>;
}

function getAnalysis(userId: string = USERS.editor) {
	return call(
		getProposalAnalysisProcedure,
		{ projectId: PROJECT_A, documentId: DOC_A },
		userId,
	) as Promise<{
		findings: Array<Record<string, unknown>>;
		noLongerRaised: Array<Record<string, unknown>>;
	}>;
}

beforeEach(() => {
	resetWorld();
	resetMocks();
});

describe("respondToFinding", () => {
	it("records an answer that the next read shows as Responded with its text", async () => {
		const run = storeRun("run-1");
		show(run);

		const result = await respond();

		expect(result).toEqual({
			outcome: "written",
			stableKey: KEY,
			answeredRunId: "run-1",
			response: {
				id: world.responses[0]?.id,
				kind: "RESPONDED",
				text: ANSWER,
				version: 1,
				author: { id: USERS.editor, name: USER_NAMES[USERS.editor] },
				updatedAt: expect.any(Date),
			},
		});
		const read = await getAnalysis();
		expect(read.findings[0]).toMatchObject({
			stableKey: KEY,
			state: "RESPONDED",
			response: { kind: "RESPONDED", text: ANSWER, version: 1 },
		});
	});

	it("records a bare confirmation", async () => {
		show(storeRun("run-1"));

		const result = await respond({ kind: "CONFIRMED", text: undefined });

		expect(result).toMatchObject({
			outcome: "written",
			response: { kind: "CONFIRMED", text: null },
		});
		expect((await getAnalysis()).findings[0]).toMatchObject({
			state: "CONFIRMED",
		});
	});

	it("writes in the owning organization, against the current section hash, with the session user as author", async () => {
		show(storeRun("run-1"));
		const edited = PROPOSAL_BODY.replace(
			"reporting dashboard",
			"reporting suite",
		);
		setBody(edited);
		const editedScope = buildSectionMap(edited).sections.find(
			(section) => section.key === SCOPE.key,
		);

		await respond({ authorId: USERS.owner });

		expect(mocks.upsertFindingResponse).toHaveBeenCalledWith({
			organizationId: ORG_A,
			projectId: PROJECT_A,
			documentId: DOC_A,
			stableKey: KEY,
			kind: "RESPONDED",
			text: ANSWER,
			findingTitle: "The migration has no owner",
			answeredRunId: "run-1",
			sectionKey: SCOPE.key,
			sectionHash: editedScope?.proseHash,
			authorId: USERS.editor,
			expectedResponseId: undefined,
			expectedVersion: undefined,
		});
		expect(editedScope?.proseHash).not.toBe(SCOPE.proseHash);
		expect(mocks.getAnalysisForCurrentContent).toHaveBeenCalledWith({
			organizationId: ORG_A,
			documentId: DOC_A,
			currentProseHash: documentProseHash(edited),
			computeProseHash: documentProseHash,
		});
	});

	it("answers a finding that names no section against the document prose hash", async () => {
		show(
			storeRun("run-1", {
				findings: [
					storedFinding({
						id: "run-1-finding",
						stableKey: "GAP|document|pricing",
						sectionKey: DOCUMENT_SECTION_KEY,
						sectionHash: MAP.documentProseHash,
					}),
				],
			}),
		);

		await respond();

		expect(mocks.upsertFindingResponse).toHaveBeenCalledWith(
			expect.objectContaining({
				sectionKey: DOCUMENT_SECTION_KEY,
				sectionHash: MAP.documentProseHash,
			}),
		);
	});

	it("keeps the raised-against hash when the section is gone, so the answer reads as section not found", async () => {
		show(storeRun("run-1"));
		setBody(PROPOSAL_BODY.split("\n## Scope")[0]);

		await respond();

		expect(mocks.upsertFindingResponse).toHaveBeenCalledWith(
			expect.objectContaining({
				sectionKey: SCOPE.key,
				sectionHash: SCOPE.proseHash,
			}),
		);
		expect((await getAnalysis()).findings[0]).toMatchObject({
			state: "NEEDS_REVIEW",
			reason: "SECTION_NOT_FOUND",
		});
	});

	it("refuses a finding written before stable keys existed", async () => {
		show(
			storeRun("run-1", {
				findings: [
					storedFinding({
						id: "run-1-finding",
						stableKey: null,
						sectionKey: null,
						sectionHash: null,
					}),
				],
			}),
		);

		const result = await refusal(respond());

		expect(result).toMatchObject({
			code: "PRECONDITION_FAILED",
			data: { code: FINDING_NOT_KEYED_CODE },
		});
		expect(mocks.upsertFindingResponse).not.toHaveBeenCalled();
	});

	describe("which finding", () => {
		it("refuses a finding id from another run of the document", async () => {
			show(storeRun("run-1"));
			storeRun("run-0");

			const result = await refusal(
				respond({ findingId: "run-0-finding" }),
			);

			expect(result).toMatchObject({
				code: "NOT_FOUND",
				message: "Finding not found",
			});
			expect(mocks.upsertFindingResponse).not.toHaveBeenCalled();
		});

		it("refuses a run of another document, named with its own finding", async () => {
			show(storeRun("run-1"));
			storeRun("run-other-doc", { documentId: DOC_A2 });

			const result = await refusal(
				respond({
					runId: "run-other-doc",
					findingId: "run-other-doc-finding",
				}),
			);

			expect(result).toMatchObject({
				code: "NOT_FOUND",
				message: "Finding not found",
			});
			expect(mocks.upsertFindingResponse).not.toHaveBeenCalled();
		});

		it("refuses a run stored under another organization", async () => {
			show(storeRun("run-1"));
			storeRun("run-foreign", { organizationId: ORG_B });

			expect(
				(
					await refusal(
						respond({
							runId: "run-foreign",
							findingId: "run-foreign-finding",
						}),
					)
				).code,
			).toBe("NOT_FOUND");
			expect(mocks.upsertFindingResponse).not.toHaveBeenCalled();
		});

		it("refuses an unknown finding id", async () => {
			show(storeRun("run-1"));

			expect(
				(await refusal(respond({ findingId: "missing" }))).code,
			).toBe("NOT_FOUND");
		});
	});

	describe("a submit on a run the tab no longer shows", () => {
		it("carries over to a re-run of the same content and lineage, which then shows Responded, not raised again", async () => {
			storeRun("run-1");
			const rerun = storeRun("run-2", {
				sourceRunId: "run-1",
				findings: [
					storedFinding({
						id: "run-2-finding",
						title: "Nobody owns the migration",
					}),
				],
			});
			show(rerun, minutesAfter(10));

			const result = await respond();

			expect(result).toMatchObject({
				outcome: "written",
				answeredRunId: "run-2",
			});
			expect(mocks.upsertFindingResponse).toHaveBeenCalledWith(
				expect.objectContaining({
					answeredRunId: "run-2",
					findingTitle: "Nobody owns the migration",
				}),
			);
			expect((await getAnalysis()).findings[0]).toMatchObject({
				state: "RESPONDED",
				reason: null,
			});
		});

		it("carries over between two re-runs of the same source run", async () => {
			storeRun("run-1");
			storeRun("run-2", { sourceRunId: "run-1" });
			show(storeRun("run-3", { sourceRunId: "run-1" }), minutesAfter(20));

			const result = await respond({
				runId: "run-2",
				findingId: "run-2-finding",
			});

			expect(result).toMatchObject({
				outcome: "written",
				answeredRunId: "run-3",
			});
		});

		it("answers stale RUN_CHANGED across a regeneration", async () => {
			storeRun("run-1");
			const regenerated = PROPOSAL_BODY.replace(
				"We propose a pilot",
				"We propose a phased rollout",
			);
			setBody(regenerated);
			show(
				storeRun("run-5", {
					proseHash: documentProseHash(regenerated),
				}),
				minutesAfter(30),
			);

			expect(await respond()).toEqual({
				outcome: "stale",
				reason: "RUN_CHANGED",
				current: null,
			});
			expect(mocks.upsertFindingResponse).not.toHaveBeenCalled();
			expect(world.responses).toEqual([]);
		});

		it("answers stale RUN_CHANGED for a regeneration that happened to restore the same prose", async () => {
			storeRun("run-1");
			show(storeRun("run-6"), minutesAfter(30));

			expect(await respond()).toMatchObject({
				outcome: "stale",
				reason: "RUN_CHANGED",
			});
		});

		it("answers stale RUN_CHANGED between re-runs of different source runs", async () => {
			storeRun("run-1");
			storeRun("run-7");
			storeRun("run-2", { sourceRunId: "run-1" });
			show(storeRun("run-8", { sourceRunId: "run-7" }), minutesAfter(30));

			expect(
				await respond({ runId: "run-2", findingId: "run-2-finding" }),
			).toMatchObject({ outcome: "stale", reason: "RUN_CHANGED" });
		});

		it("answers stale RUN_CHANGED when the shown run does not raise the key", async () => {
			storeRun("run-1");
			show(
				storeRun("run-2", {
					sourceRunId: "run-1",
					findings: [
						storedFinding({
							id: "run-2-finding",
							stableKey: `RISK|${SCOPE.key}|vendor-lock-in`,
						}),
					],
				}),
				minutesAfter(10),
			);

			expect(await respond()).toMatchObject({
				outcome: "stale",
				reason: "RUN_CHANGED",
			});
		});

		it("answers stale RUN_CHANGED when no run is shown or the named run has no prose hash", async () => {
			storeRun("run-1");
			expect(await respond()).toMatchObject({
				outcome: "stale",
				reason: "RUN_CHANGED",
			});

			storeRun("run-old", { proseHash: null });
			show(
				storeRun("run-2", { sourceRunId: "run-old" }),
				minutesAfter(10),
			);
			expect(
				await respond({
					runId: "run-old",
					findingId: "run-old-finding",
				}),
			).toMatchObject({ outcome: "stale", reason: "RUN_CHANGED" });
		});
	});

	describe("versions", () => {
		function savedBy(authorId: string, version: number) {
			world.responses.push({
				id: "response-saved",
				organizationId: ORG_A,
				projectId: PROJECT_A,
				documentId: DOC_A,
				stableKey: KEY,
				kind: "RESPONDED",
				text: "Their answer.",
				findingTitle: "The migration has no owner",
				answeredRunId: "run-1",
				sectionKey: SCOPE.key,
				sectionHash: SCOPE.proseHash,
				authorId,
				version,
				createdAt: minutesAfter(5),
				updatedAt: minutesAfter(6),
			});
		}

		it("replaces the answer the member saw and bumps its version", async () => {
			show(storeRun("run-1"));
			savedBy(USERS.owner, 1);

			const result = await respond({
				responseId: "response-saved",
				version: 1,
				text: "Updated answer.",
			});

			expect(result).toMatchObject({
				outcome: "written",
				response: {
					id: "response-saved",
					text: "Updated answer.",
					version: 2,
					author: { id: USERS.editor },
				},
			});
			expect(mocks.upsertFindingResponse).toHaveBeenCalledWith(
				expect.objectContaining({
					expectedResponseId: "response-saved",
					expectedVersion: 1,
				}),
			);
		});

		it("answers stale VERSION_CHANGED with the answer another member saved and its author", async () => {
			show(storeRun("run-1"));
			savedBy(USERS.owner, 2);

			const result = await respond({
				responseId: "response-saved",
				version: 1,
			});

			expect(result).toEqual({
				outcome: "stale",
				reason: "VERSION_CHANGED",
				current: {
					id: "response-saved",
					kind: "RESPONDED",
					text: "Their answer.",
					version: 2,
					author: { id: USERS.owner, name: USER_NAMES[USERS.owner] },
					updatedAt: minutesAfter(6),
				},
			});
			expect(world.responses[0]).toMatchObject({
				text: "Their answer.",
				version: 2,
			});
		});

		it("answers stale VERSION_CHANGED when an answer was saved before a first submit", async () => {
			show(storeRun("run-1"));
			savedBy(USERS.owner, 1);

			expect(await respond()).toMatchObject({
				outcome: "stale",
				reason: "VERSION_CHANGED",
				current: { version: 1, author: { id: USERS.owner } },
			});
		});

		it("answers stale VERSION_CHANGED with no answer when it was cleared meanwhile", async () => {
			show(storeRun("run-1"));

			expect(
				await respond({ responseId: "response-gone", version: 3 }),
			).toEqual({
				outcome: "stale",
				reason: "VERSION_CHANGED",
				current: null,
			});
		});

		it("answers stale VERSION_CHANGED for an answer cleared and given again, though it is back at the version the member saw", async () => {
			show(storeRun("run-1"));
			const clear = (seen: { id: unknown; version: unknown }) =>
				call(clearFindingResponseProcedure, {
					projectId: PROJECT_A,
					documentId: DOC_A,
					stableKey: KEY,
					responseId: seen.id,
					version: seen.version,
				});

			const first = await respond();
			expect(first.outcome).toBe("written");
			const seen = first.response as { id: string; version: number };
			expect(seen.version).toBe(1);
			expect(await clear(seen)).toEqual({
				outcome: "cleared",
				stableKey: KEY,
			});
			const again = await respond({
				kind: "CONFIRMED",
				text: undefined,
			});
			const current = again.response as { id: string; version: number };
			expect(current.version).toBe(1);
			expect(current.id).not.toBe(seen.id);

			expect(
				await respond({
					responseId: seen.id,
					version: seen.version,
					text: "A late edit of the cleared answer.",
				}),
			).toEqual({
				outcome: "stale",
				reason: "VERSION_CHANGED",
				current: {
					id: current.id,
					kind: "CONFIRMED",
					text: null,
					version: 1,
					author: {
						id: USERS.editor,
						name: USER_NAMES[USERS.editor],
					},
					updatedAt: expect.any(Date),
				},
			});
			expect(await clear(seen)).toMatchObject({
				outcome: "stale",
				reason: "VERSION_CHANGED",
				current: { id: current.id, kind: "CONFIRMED", version: 1 },
			});
			expect(world.responses).toEqual([
				expect.objectContaining({
					id: current.id,
					kind: "CONFIRMED",
					text: null,
					version: 1,
				}),
			]);
		});
	});

	describe("input", () => {
		it("accepts CONFIRMED and RESPONDED only", () => {
			const schema = inputSchema(respondToFindingProcedure);
			const base = {
				projectId: PROJECT_A,
				documentId: DOC_A,
				runId: "run-1",
				findingId: "run-1-finding",
			};

			for (const kind of ["CONFIRMED", "RESPONDED"]) {
				expect(schema.safeParse({ ...base, kind }).success).toBe(true);
			}
			for (const kind of [
				"RESOLVED",
				"UNADDRESSED",
				"NEEDS_REVIEW",
				"",
			]) {
				expect(schema.safeParse({ ...base, kind }).success).toBe(false);
			}
		});

		it("refuses a version without the answer's id, or an id without its version, as BAD_REQUEST before reading the analysis", async () => {
			show(storeRun("run-1"));

			for (const [seen, path] of [
				[{ version: 1 }, "responseId"],
				[{ responseId: "response-saved" }, "version"],
			] as const) {
				const result = await inputRefusal(respond(seen));

				expect(result.code).toBe("BAD_REQUEST");
				expect(result.issues).toEqual([
					expect.objectContaining({
						path: [path],
						params: { code: VERSION_AND_RESPONSE_ID_TOGETHER_CODE },
					}),
				]);
			}
			expect(mocks.getAnalysisForCurrentContent).not.toHaveBeenCalled();
			expect(mocks.upsertFindingResponse).not.toHaveBeenCalled();
		});

		it("accepts the answer's id and version together, or neither", () => {
			const schema = inputSchema(respondToFindingProcedure);
			const base = {
				projectId: PROJECT_A,
				documentId: DOC_A,
				runId: "run-1",
				findingId: "run-1-finding",
				kind: "CONFIRMED",
			};

			expect(schema.safeParse(base).success).toBe(true);
			expect(
				schema.safeParse({
					...base,
					responseId: "response-saved",
					version: 2,
				}).success,
			).toBe(true);
			expect(
				schema.safeParse({ ...base, responseId: "", version: 2 })
					.success,
			).toBe(false);
		});

		it("refuses an answer without text, or one over the limit, before reading the analysis", async () => {
			show(storeRun("run-1"));

			expect(await refusal(respond({ text: "   " }))).toMatchObject({
				code: "BAD_REQUEST",
				data: { code: "textRequired" },
			});
			expect(
				await refusal(
					respond({
						text: "x".repeat(
							PROPOSAL_FINDING_RESPONSE_TEXT_MAX_LENGTH + 1,
						),
					}),
				),
			).toMatchObject({
				code: "BAD_REQUEST",
				data: { code: "textTooLong" },
			});
			expect(mocks.getAnalysisForCurrentContent).not.toHaveBeenCalled();
			expect(mocks.upsertFindingResponse).not.toHaveBeenCalled();
		});

		it("accepts text at the limit once trimmed", async () => {
			show(storeRun("run-1"));

			const result = await respond({
				text: ` ${"x".repeat(PROPOSAL_FINDING_RESPONSE_TEXT_MAX_LENGTH)} `,
			});

			expect(result.outcome).toBe("written");
		});
	});

	describe("audit", () => {
		it("records the key, kind, version and run ids, never the text or the finding title", async () => {
			storeRun("run-1");
			show(
				storeRun("run-2", {
					sourceRunId: "run-1",
					findings: [
						storedFinding({
							id: "run-2-finding",
							title: "Nobody owns the migration",
						}),
					],
				}),
				minutesAfter(10),
			);

			await respond();

			const rows = auditRows();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				action: "project.document_analysis.responded",
				category: "project",
				outcome: "success",
				organizationId: ORG_A,
				projectId: PROJECT_A,
				resource: { type: "project_document", id: DOC_A, name: null },
			});
			expect(rows[0].metadata).toEqual({
				stableKey: KEY,
				kind: "RESPONDED",
				version: 1,
				answeredRunId: "run-2",
				requestedRunId: "run-1",
				carriedOver: true,
			});
			const serialized = JSON.stringify(rows[0]);
			expect(serialized).not.toContain(ANSWER);
			expect(serialized).not.toContain("owns the migration");
			expect(serialized).not.toContain("has no owner");
		});

		it("records nothing for a stale submit", async () => {
			storeRun("run-1");

			await respond();

			expect(auditRows()).toEqual([]);
		});
	});
});
