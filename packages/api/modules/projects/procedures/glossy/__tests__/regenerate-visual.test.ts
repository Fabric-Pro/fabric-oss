/**
 * `projects.glossy.regenerateVisual` (Fizzy #2589, R18, R27, R28, R30, KTD6,
 * KTD8, KTD10, KTD19, KTD21, AE6, AE10).
 *
 * The permission decision, the Glossy gate, `planGlossyKeys`,
 * `planGlossyRegeneration`, and `extractGlossyVisual` — spec validation and
 * the label guard included — are real; the "model" (`generateObject`), the
 * rate limit, and the audit writer are mocks. The edition queries run over
 * `useEditionStore`, which applies the real queries' guards. That the
 * replacement's cache key is the one the build's extract activity reads is
 * proven against the real activities in
 * `packages/temporal/src/activities/glossy-edition/__tests__/regeneration-plan.test.ts`;
 * the same guarantees against real Postgres are in
 * `packages/database/__tests__/glossy-editions.integration.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () =>
	(await import("./glossy-harness")).databaseModule(),
);
vi.mock("@repo/temporal", async () =>
	(await import("./glossy-harness")).temporalModule(),
);
vi.mock("@repo/ai", async () => (await import("./glossy-harness")).aiModule());
vi.mock("@repo/storage", async () =>
	(await import("./glossy-harness")).storageModule(),
);
vi.mock("../../../../../orpc/procedures", async () =>
	(await import("./glossy-harness")).proceduresModule(),
);
vi.mock("../../../../../lib/audit", async () => ({
	recordAuditFromRequest: (await import("./glossy-harness")).mocks
		.recordAudit,
}));

import { GLOSSY_PIPELINE_VERSION } from "@repo/agent-prompts/glossy";
import {
	computeDetectedVisualKey,
	computeExtractionKey,
} from "@repo/utils/glossy/keys";
import { specHash } from "@repo/utils/glossy/visual-spec";
import { assertProjectPermission } from "../../../../../orpc/middleware/require-permission";
import { getGlossyEditionProcedure } from "../get-edition";
import { regenerateGlossyVisualProcedure } from "../regenerate-visual";
import { reviewGlossyVisualProcedure } from "../review-visual";
import {
	call,
	DOC_A,
	DOC_B,
	errorCode,
	mocks,
	ORG_A,
	PROJECT_A,
	PROJECT_B,
	resetMocks,
	resetWorld,
	USERS,
	usePermissionCheck,
	world,
} from "./glossy-harness";
import {
	claimBy,
	ORG_CHART,
	PUBLISHED_BUILD_ID,
	storedContent,
	usePublishedEdition,
} from "./glossy-visual-fixture";

usePermissionCheck(assertProjectPermission);

const regenerate = (
	visualKey: string,
	userId: string = USERS.editor,
	target: { projectId?: string; documentId?: string } = {},
) =>
	call(
		regenerateGlossyVisualProcedure,
		{
			projectId: target.projectId ?? PROJECT_A,
			documentId: target.documentId ?? DOC_A,
			visualKey,
		},
		userId,
	);

/** A second org chart of the Team section, every label from its text. */
const NEW_ORG_CHART = {
	kind: "org_chart",
	title: "Team",
	nodes: [
		{ id: "a", label: "Alex leads delivery", parentId: null },
		{ id: "s", label: "Sam owns design", parentId: "a" },
	],
} as const;

const NEW_STAT = {
	kind: "stat",
	title: "Example Org pilot",
	items: [{ value: "$240k", label: "Pilot costing" }],
} as const;

/** What the "model" answers for the next extraction. */
function modelReturns(spec: unknown) {
	mocks.generateObject.mockResolvedValueOnce({ object: { spec }, usage: {} });
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

beforeEach(() => {
	resetWorld();
	resetMocks();
});

describe("projects.glossy.regenerateVisual — a fresh visual of the same kind (R27)", () => {
	it("re-plans from the published snapshot, extracts once as the editor, and writes under the build's extraction key", async () => {
		const { store, keys, sections, content } = usePublishedEdition();
		modelReturns(NEW_ORG_CHART);

		const result = await regenerate(keys.team);

		expect(result).toEqual({
			outcome: "regenerated",
			visualKey: keys.team,
			kind: "org_chart",
			specHash: specHash(NEW_ORG_CHART),
			contentRevision: 4,
		});
		expect(mocks.enforceAiRateLimit).toHaveBeenCalledWith(
			USERS.editor,
			expect.anything(),
		);
		expect(mocks.extract).toHaveBeenCalledTimes(1);
		expect(mocks.extract.mock.calls[0][0]).toMatchObject({
			userId: USERS.editor,
			organizationId: ORG_A,
			projectId: PROJECT_A,
			documentType: "PROPOSAL",
			// The section of the published snapshot, not the live document.
			section: {
				heading: "Team",
				markdown: sections.team.section.markdown,
			},
			kind: "org_chart",
			slotHint: null,
			styleDirection: "Calm",
			variantNonce: expect.any(String),
		});

		// The one cache row, under the key the build's extract activity reads.
		expect([...store.extractionCache.entries()]).toEqual([
			[
				computeExtractionKey({
					sectionKey: sections.team.key,
					kind: "org_chart",
					slotHint: null,
					styleDirection: "Calm",
					pipelineVersion: GLOSSY_PIPELINE_VERSION,
				}),
				{
					sectionKey: sections.team.key,
					output: { spec: NEW_ORG_CHART },
				},
			],
		]);
		// Only that visual changed; the rest of the edition is as it was.
		const stored = storedContent(store);
		expect(stored.visuals[keys.team]).toEqual({
			kind: "org_chart",
			spec: NEW_ORG_CHART,
			specHash: specHash(NEW_ORG_CHART),
			source: "detected",
			reason: "Roles and ownership",
		});
		expect({ ...stored, visuals: {} }).toEqual({ ...content, visuals: {} });
		expect(stored.visuals[keys.exec]).toEqual(content.visuals[keys.exec]);

		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
		const audit = mocks.recordAudit.mock.calls[0][1];
		expect(audit).toMatchObject({
			action: "project.glossy_edition.visual_regenerated",
			outcome: "success",
			organizationId: ORG_A,
			projectId: PROJECT_A,
			resource: { type: "project_document", id: DOC_A },
			metadata: {
				visualKey: keys.team,
				kind: "org_chart",
				contentRevision: 4,
			},
		});
		// Keys and kinds only: no spec text in the audit row.
		expect(JSON.stringify(audit)).not.toContain("Alex");
	});

	it("a slot's visual is extracted with the slot's hint and kind, and keyed with them", async () => {
		const { store, keys, sections } = usePublishedEdition();
		modelReturns(NEW_STAT);

		expect(await regenerate(keys.exec)).toMatchObject({
			outcome: "regenerated",
			kind: "stat",
		});
		expect(mocks.extract.mock.calls[0][0]).toMatchObject({
			kind: "stat",
			slotHint: "the budget",
			styleDirection: "Calm",
		});
		expect([...store.extractionCache.keys()]).toEqual([
			computeExtractionKey({
				sectionKey: sections.exec.key,
				kind: "stat",
				slotHint: "the budget",
				styleDirection: "Calm",
				// A slot's extraction is keyed by its own id too, so two slots
				// of one kind in a section keep distinct visuals.
				slotId: "slot-1",
				pipelineVersion: GLOSSY_PIPELINE_VERSION,
			}),
		]);
		expect(storedContent(store).visuals[keys.exec]).toMatchObject({
			spec: NEW_STAT,
			source: "slot",
		});
	});

	it("asks for a different variant each time", async () => {
		const { keys } = usePublishedEdition();
		modelReturns(NEW_ORG_CHART);
		modelReturns(ORG_CHART);

		await regenerate(keys.team);
		await regenerate(keys.team);

		const [first, second] = mocks.extract.mock.calls.map(
			([input]) => input.variantNonce,
		);
		expect(first).toEqual(expect.any(String));
		expect(second).not.toBe(first);
	});
});

describe("projects.glossy.regenerateVisual — refusals, and the old visual kept", () => {
	it("regenerate during a build is refused with the holder, and nothing runs", async () => {
		const { store, keys, content } = usePublishedEdition();
		claimBy(store, "build-running", USERS.guestEditor);

		expect(await regenerate(keys.team)).toEqual({
			outcome: "building",
			holder: {
				startedBy: { id: USERS.guestEditor, name: "Gus Guest" },
				startedAt: new Date("2026-09-24T12:00:00.000Z"),
			},
			stuck: false,
		});
		expect(mocks.enforceAiRateLimit).not.toHaveBeenCalled();
		expect(mocks.extract).not.toHaveBeenCalled();
		expect(mocks.applyVisualRegeneration).not.toHaveBeenCalled();
		expect(store.content).toEqual(content);
	});

	it("a stuck holder (stale heartbeat, run gone) is reported as stuck, so the page offers a rebuild", async () => {
		const { store, keys } = usePublishedEdition();
		claimBy(store, "build-stuck", USERS.guestEditor);
		const holder = store.builds.get("build-stuck");
		if (!holder) {
			throw new Error("fixture: no holder");
		}
		holder.heartbeatAt = new Date(Date.now() - 60 * 60 * 1000);
		mocks.describe.mockResolvedValue({ status: { name: "TIMED_OUT" } });

		expect(await regenerate(keys.team)).toMatchObject({
			outcome: "building",
			stuck: true,
		});
		expect(mocks.extract).not.toHaveBeenCalled();
		expect(mocks.applyVisualRegeneration).not.toHaveBeenCalled();
	});

	it("covers R18: a replacement the label guard refuses keeps the old visual → noValidReplacement", async () => {
		const { store, keys, content } = usePublishedEdition();
		// "Chris" is not in the Team section.
		modelReturns({
			kind: "org_chart",
			nodes: [
				{ id: "a", label: "Alex", parentId: null },
				{ id: "c", label: "Chris", parentId: "a" },
			],
		});

		expect(await regenerate(keys.team)).toEqual({
			outcome: "noValidReplacement",
			reason: "fact_check",
		});
		expect(mocks.applyVisualRegeneration).not.toHaveBeenCalled();
		expect(store.content).toEqual(content);
		expect(store.contentRevision).toBe(3);
		expect(store.extractionCache.size).toBe(0);

		// Traceable (R30), by reason code and never by the rejected text.
		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
		const audit = mocks.recordAudit.mock.calls[0][1];
		expect(audit).toMatchObject({
			action: "project.glossy_edition.visual_regenerated",
			outcome: "failure",
			metadata: {
				visualKey: keys.team,
				kind: "org_chart",
				reason: "fact_check",
			},
		});
		expect(JSON.stringify(audit)).not.toContain("Chris");
	});

	it("a replacement of another kind keeps the old visual too", async () => {
		const { store, keys, content } = usePublishedEdition();
		modelReturns(NEW_STAT);

		expect(await regenerate(keys.team)).toEqual({
			outcome: "noValidReplacement",
			reason: "kind_mismatch",
		});
		expect(store.content).toEqual(content);
	});

	it("an unknown visual key is refused, with no model call", async () => {
		usePublishedEdition();

		expect(await regenerate("not-a-visual")).toEqual({
			outcome: "visualNotFound",
		});
		expect(await regenerate("__proto__")).toEqual({
			outcome: "visualNotFound",
		});
		expect(mocks.extract).not.toHaveBeenCalled();
		expect(mocks.enforceAiRateLimit).not.toHaveBeenCalled();
	});

	it("a document with no edition yet has no visual to regenerate", async () => {
		mocks.getGlossyEdition.mockResolvedValue(null);
		expect(await regenerate("any")).toEqual({ outcome: "visualNotFound" });
	});

	it("an existing diagram is restyled, not extracted: notRegenerable", async () => {
		const { keys } = usePublishedEdition();
		expect(await regenerate(keys.mermaid)).toEqual({
			outcome: "notRegenerable",
		});
		expect(mocks.extract).not.toHaveBeenCalled();
	});

	it("an edition built under an older pipeline needs a rebuild", async () => {
		const { store, keys } = usePublishedEdition();
		store.content = {
			...storedContent(store),
			pipelineVersion: "2026-01-01.0",
		};

		expect(await regenerate(keys.team)).toEqual({
			outcome: "rebuildRequired",
		});
		expect(mocks.extract).not.toHaveBeenCalled();
	});

	it("a published snapshot that names another tenant is never read into a model", async () => {
		const { store, keys, snapshot } = usePublishedEdition();
		store.snapshots.set(PUBLISHED_BUILD_ID, {
			...snapshot,
			organizationId: "org-b",
		});

		expect(await regenerate(keys.team)).toEqual({
			outcome: "rebuildRequired",
		});
		expect(mocks.extract).not.toHaveBeenCalled();
	});
});

describe("projects.glossy.regenerateVisual — BYOK (R10, KTD21)", () => {
	it("covers AE6: no organization key and no personal key → aiProviderNotConfigured, nothing written", async () => {
		const { store, keys, content } = usePublishedEdition();
		world.orgProviderKeys.delete(ORG_A);

		expect(await regenerate(keys.team)).toEqual({
			outcome: "aiProviderNotConfigured",
			message: expect.stringContaining("AI provider"),
		});
		expect(mocks.generateObject).not.toHaveBeenCalled();
		expect(mocks.applyVisualRegeneration).not.toHaveBeenCalled();
		expect(store.content).toEqual(content);
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("with the editor's personal key only, the regenerate runs as that editor in the project's organization", async () => {
		const { keys } = usePublishedEdition();
		world.orgProviderKeys.delete(ORG_A);
		world.personalProviderKeys.add(USERS.editor);
		modelReturns(NEW_ORG_CHART);

		expect((await regenerate(keys.team)).outcome).toBe("regenerated");
		expect(mocks.getAIModel.mock.calls[0][1]).toMatchObject({
			userId: USERS.editor,
			organizationId: ORG_A,
			projectId: PROJECT_A,
			featureKey: "glossy-edition",
		});
	});
});

describe("projects.glossy.regenerateVisual — racing writers (KTD10)", () => {
	/**
	 * Hold each extraction until released, answering with the given spec by
	 * requested kind. Nothing here calls the model twice.
	 */
	function gateExtractions(specs: Record<string, unknown>) {
		const gates: Record<string, ReturnType<typeof deferred>> = {};
		for (const kind of Object.keys(specs)) {
			gates[kind] = deferred();
		}
		mocks.extract.mockImplementation(async (input: { kind: string }) => {
			await gates[input.kind].promise;
			return { status: "extracted", spec: specs[input.kind] };
		});
		return gates;
	}

	it("two concurrent regenerates on different visuals both persist", async () => {
		const { store, keys, sections } = usePublishedEdition();
		const gates = gateExtractions({
			org_chart: NEW_ORG_CHART,
			stat: NEW_STAT,
		});

		const team = regenerate(keys.team);
		const exec = regenerate(keys.exec);
		// Both have read revision 3 and are waiting on their model call.
		await vi.waitFor(() => expect(mocks.extract).toHaveBeenCalledTimes(2));

		gates.stat.resolve();
		expect(await exec).toMatchObject({
			outcome: "regenerated",
			contentRevision: 4,
		});
		gates.org_chart.resolve();
		// Its write at revision 3 was refused; the splice was re-applied to
		// revision 4 without a second model call.
		expect(await team).toMatchObject({
			outcome: "regenerated",
			contentRevision: 5,
		});

		expect(mocks.extract).toHaveBeenCalledTimes(2);
		expect(mocks.applyVisualRegeneration).toHaveBeenCalledTimes(3);
		const stored = storedContent(store);
		expect(stored.visuals[keys.team].spec).toEqual(NEW_ORG_CHART);
		expect(stored.visuals[keys.exec].spec).toEqual(NEW_STAT);
		expect(store.contentRevision).toBe(5);
		expect(
			[...store.extractionCache.values()]
				.map((row) => row.sectionKey)
				.sort(),
		).toEqual([sections.exec.key, sections.team.key].sort());
	});

	it("a regenerate that loses the write race on every attempt gives up as superseded and writes nothing", async () => {
		const { store, keys, sections } = usePublishedEdition();
		// Losing all MAX_WRITE_ATTEMPTS (3) takes a rival write between the
		// loser's every read and its write, so four regenerates race on one
		// content revision: the loser and three rivals, each on its own
		// visual. The published edition gains two detected visuals for that.
		const flowKey = computeDetectedVisualKey({
			sectionKey: sections.approach.key,
			kind: "flow",
			pipelineVersion: GLOSSY_PIPELINE_VERSION,
		});
		const timelineKey = computeDetectedVisualKey({
			sectionKey: sections.team.key,
			kind: "timeline",
			pipelineVersion: GLOSSY_PIPELINE_VERSION,
		});
		const FLOW = {
			kind: "flow",
			steps: [{ label: "Discover" }, { label: "Build" }],
		} as const;
		const TIMELINE = {
			kind: "timeline",
			items: [
				{ date: "Q3 2026", label: "Pilot starts" },
				{ date: "Q4 2026", label: "Pilot review" },
			],
		} as const;
		const withMore = storedContent(store);
		for (const [sectionKey, visualKey, spec] of [
			[sections.approach.key, flowKey, FLOW],
			[sections.team.key, timelineKey, TIMELINE],
		] as const) {
			withMore.visuals[visualKey] = {
				kind: spec.kind,
				spec,
				specHash: specHash(spec),
				source: "detected",
			};
			withMore.sections
				.find((section) => section.sectionKey === sectionKey)
				?.anchors.push({
					blockIndex: 1,
					ref: { type: "visual", visualKey },
				});
		}
		const before = structuredClone(withMore);

		const gates = gateExtractions({
			org_chart: NEW_ORG_CHART,
			stat: NEW_STAT,
			flow: {
				kind: "flow",
				steps: [{ label: "Discover" }, { label: "Build and measure" }],
			},
			timeline: {
				kind: "timeline",
				items: [
					{ date: "Q3 2026", label: "Pilot" },
					{ date: "Q1 2027", label: "Rollout" },
				],
			},
		});

		const loser = regenerate(keys.team);
		const rivals = [
			{ gate: gates.stat, result: regenerate(keys.exec) },
			{ gate: gates.flow, result: regenerate(flowKey) },
			{ gate: gates.timeline, result: regenerate(timelineKey) },
		];
		// All four have read revision 3 and are waiting on their model call.
		await vi.waitFor(() => expect(mocks.extract).toHaveBeenCalledTimes(4));

		// Just before each of the loser's writes, one rival commits.
		const storeWrite =
			mocks.applyVisualRegeneration.getMockImplementation();
		const waiting = [...rivals];
		mocks.applyVisualRegeneration.mockImplementation(
			async (input: { visualKey: string }) => {
				if (input.visualKey === keys.team) {
					const rival = waiting.shift();
					if (rival) {
						rival.gate.resolve();
						await rival.result;
					}
				}
				return storeWrite?.(input);
			},
		);
		gates.org_chart.resolve();

		expect(await loser).toEqual({ outcome: "superseded" });
		for (const rival of rivals) {
			expect(await rival.result).toMatchObject({
				outcome: "regenerated",
			});
		}

		// Three writes at revisions 3, 4 and 5, each refused; no model call
		// beyond the first.
		const loserWrites = mocks.applyVisualRegeneration.mock.calls
			.map(([input]) => input)
			.filter((input) => input.visualKey === keys.team);
		expect(
			loserWrites.map((input) => input.expectedContentRevision),
		).toEqual([3, 4, 5]);
		expect(mocks.extract).toHaveBeenCalledTimes(4);

		// Nothing of the loser's was written: no content, no cache row, no audit.
		const loserCacheKey = loserWrites[0].cacheEntry.cacheKey;
		expect(store.extractionCache.has(loserCacheKey)).toBe(false);
		expect(store.extractionCache.size).toBe(3);
		expect(store.contentRevision).toBe(6);
		const stored = storedContent(store);
		expect(stored.visuals[keys.team]).toEqual(before.visuals[keys.team]);
		expect(stored.visuals[keys.exec].spec).toEqual(NEW_STAT);
		expect(stored.visuals[flowKey].specHash).not.toBe(
			before.visuals[flowKey].specHash,
		);
		expect(stored.visuals[timelineKey].specHash).not.toBe(
			before.visuals[timelineKey].specHash,
		);
		expect(
			mocks.recordAudit.mock.calls.filter(
				([, entry]) => entry.metadata?.visualKey === keys.team,
			),
		).toEqual([]);
		expect(mocks.recordAudit).toHaveBeenCalledTimes(3);
	});

	it("a regenerate refused because a rebuild claimed in between writes no cache row", async () => {
		const { store, keys, content } = usePublishedEdition();
		const gates = gateExtractions({ org_chart: NEW_ORG_CHART });

		const pending = regenerate(keys.team);
		await vi.waitFor(() => expect(mocks.extract).toHaveBeenCalledTimes(1));
		claimBy(store, "build-rebuild", USERS.owner);
		gates.org_chart.resolve();

		expect(await pending).toEqual({
			outcome: "building",
			holder: {
				startedBy: { id: USERS.owner, name: "Olivia Owner" },
				startedAt: new Date("2026-09-24T12:00:00.000Z"),
			},
			stuck: false,
		});
		expect(mocks.applyVisualRegeneration).toHaveBeenCalledTimes(1);
		expect(store.extractionCache.size).toBe(0);
		expect(store.content).toEqual(content);
		expect(store.contentRevision).toBe(3);
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("a rebuild that published in between supersedes the regenerate, which writes nothing", async () => {
		const { store, keys, content } = usePublishedEdition();
		const gates = gateExtractions({ org_chart: NEW_ORG_CHART });

		const pending = regenerate(keys.team);
		await vi.waitFor(() => expect(mocks.extract).toHaveBeenCalledTimes(1));
		// Finalize of a newer build: new published attempt, new revision.
		store.publishedBuildId = "build-newer";
		store.contentRevision += 1;
		gates.org_chart.resolve();

		expect(await pending).toEqual({ outcome: "superseded" });
		expect(store.extractionCache.size).toBe(0);
		expect(store.content).toEqual(content);
	});
});

describe("projects.glossy.regenerateVisual — review (R28)", () => {
	it("accept, then regenerate → the badge reads Pending", async () => {
		const { keys, content } = usePublishedEdition();
		const read = async () =>
			(
				(await call(getGlossyEditionProcedure, {
					projectId: PROJECT_A,
					documentId: DOC_A,
				})) as {
					edition: {
						decisions: Array<{
							visualKey: string;
							decision: string;
						}>;
					};
				}
			).edition.decisions;

		await call(reviewGlossyVisualProcedure, {
			projectId: PROJECT_A,
			documentId: DOC_A,
			visualKey: keys.team,
			decision: "accept",
			specHash: content.visuals[keys.team].specHash,
		});
		expect(await read()).toEqual([
			expect.objectContaining({
				visualKey: keys.team,
				decision: "ACCEPTED",
			}),
		]);

		modelReturns(NEW_ORG_CHART);
		expect((await regenerate(keys.team)).outcome).toBe("regenerated");

		// No decision: the visual is pending again, and still included.
		expect(await read()).toEqual([]);
	});
});

describe("projects.glossy.regenerateVisual — access (KTD19)", () => {
	it("covers AE10: the rollout gate off → NOT_FOUND, and nothing runs", async () => {
		const { keys } = usePublishedEdition();
		world.flags.set(ORG_A, false);

		expect(await errorCode(regenerate(keys.team))).toBe("NOT_FOUND");
		expect(mocks.getGlossyEdition).not.toHaveBeenCalled();
		expect(mocks.extract).not.toHaveBeenCalled();
	});

	it("a guest viewer is FORBIDDEN; a guest editor regenerates in the host organization", async () => {
		const { keys } = usePublishedEdition();

		expect(await errorCode(regenerate(keys.team, USERS.guestViewer))).toBe(
			"FORBIDDEN",
		);
		expect(mocks.extract).not.toHaveBeenCalled();

		modelReturns(NEW_ORG_CHART);
		expect((await regenerate(keys.team, USERS.guestEditor)).outcome).toBe(
			"regenerated",
		);
		expect(mocks.extract.mock.calls[0][0]).toMatchObject({
			userId: USERS.guestEditor,
			organizationId: ORG_A,
		});
		expect(mocks.recordAudit.mock.calls[0][1]).toMatchObject({
			organizationId: ORG_A,
		});
	});

	it("NOT_FOUND: another tenant, another project's document, and a trashed project", async () => {
		const { keys } = usePublishedEdition();

		expect(await errorCode(regenerate(keys.team, USERS.outsider))).toBe(
			"NOT_FOUND",
		);
		expect(
			await errorCode(
				regenerate(keys.team, USERS.editor, { documentId: DOC_B }),
			),
		).toBe("NOT_FOUND");
		expect(
			await errorCode(
				regenerate(keys.team, USERS.guestEditor, {
					projectId: PROJECT_B,
				}),
			),
		).toBe("NOT_FOUND");

		const project = world.projects.get(PROJECT_A);
		world.projects.set(PROJECT_A, {
			...(project as NonNullable<typeof project>),
			deletedAt: new Date("2026-09-20T00:00:00.000Z"),
		});
		expect(await errorCode(regenerate(keys.team))).toBe("NOT_FOUND");
		expect(mocks.extract).not.toHaveBeenCalled();
	});
});

describe("projects.glossy.regenerateVisual — declaration", () => {
	it("is a write: DOCUMENT_UPDATE", () => {
		expect(
			(
				regenerateGlossyVisualProcedure as unknown as {
					__permission: string;
				}
			).__permission,
		).toBe("document:update");
	});
});
