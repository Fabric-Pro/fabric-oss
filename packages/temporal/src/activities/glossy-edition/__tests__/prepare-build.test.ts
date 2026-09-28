/**
 * `prepareGlossyBuildActivity` (Fizzy #2589, R3, R5, R10, KTD4, KTD9,
 * KTD20): the re-checks a build makes before any model work, and the visual
 * plan it hands the workflow.
 *
 * The database and model resolution are mocked; cleanup and the section keys
 * are the real, pure modules, so the plan is computed from real sections.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	projectDocument: { findUnique: vi.fn() },
	glossyEdition: { findUnique: vi.fn() },
}));
const database = vi.hoisted(() => ({
	getGlossyBuildSnapshot: vi.fn(),
	heartbeatGlossyBuild: vi.fn(),
	markGlossyBuildSuperseded: vi.fn(),
	isFeatureEnabled: vi.fn(),
	canEditProject: vi.fn(),
}));
const model = vi.hoisted(() => ({ resolveGlossyModel: vi.fn() }));

vi.mock("@repo/database", () => ({ db, ...database }));
vi.mock("../../../lib/glossy/model", () => ({
	resolveGlossyModel: model.resolveGlossyModel,
	GLOSSY_AI_PROVIDER_NOT_CONFIGURED_MESSAGE: "Configure an AI provider.",
}));

import type { EditionVisual } from "@repo/utils/glossy/edition-content";
import {
	planGlossyVisuals,
	prepareGlossyBuildActivity,
} from "../prepare-build";
import { normalizeBuildOptions } from "../shared";
import type { PrepareGlossyBuildInput } from "../types";
import {
	DOCUMENT,
	editionContent,
	REF,
	sectionsOf,
	snapshotOf,
	verdict,
} from "./glossy-fixtures";

const INPUT: PrepareGlossyBuildInput = {
	...REF,
	options: { mode: "roll_the_dice", lengthMode: "brief" },
};

const [EXEC, APPROACH, TEAM] = sectionsOf().map((entry) => entry.key);

const TEAM_ORG_CHART: EditionVisual = {
	kind: "org_chart",
	spec: {
		kind: "org_chart",
		nodes: [
			{ id: "a", label: "Alex", parentId: null },
			{ id: "s", label: "Sam", parentId: "a" },
		],
	},
	specHash: "hash",
	source: "detected",
	reason: "Roles and ownership",
};

/** Published sections under `keys`, each showing the visual `visualKeys` names for it. */
function publishedSections(
	keys: string[],
	visualKeys: Record<string, string> = {},
) {
	return keys.map((sectionKey) => ({
		sectionKey,
		headingPath: [],
		heading: null,
		level: 2,
		markdown: "text",
		wording: "rewritten" as const,
		anchors: visualKeys[sectionKey]
			? [
					{
						blockIndex: 1,
						ref: {
							type: "visual" as const,
							visualKey: visualKeys[sectionKey],
						},
					},
				]
			: [],
	}));
}

function documentRow(overrides: Record<string, unknown> = {}) {
	return {
		projectId: "proj-1",
		organizationId: "org-1",
		type: "PROPOSAL",
		status: "COMPLETE",
		project: { organizationId: "org-1", deletedAt: null },
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	db.projectDocument.findUnique.mockResolvedValue(documentRow());
	db.glossyEdition.findUnique.mockResolvedValue(null);
	database.getGlossyBuildSnapshot.mockResolvedValue(snapshotOf());
	database.heartbeatGlossyBuild.mockResolvedValue("applied");
	database.markGlossyBuildSuperseded.mockResolvedValue("marked");
	database.isFeatureEnabled.mockResolvedValue(true);
	database.canEditProject.mockResolvedValue(true);
	model.resolveGlossyModel.mockResolvedValue({ status: "resolved" });
});

describe("prepareGlossyBuildActivity — a first build", () => {
	it("keys the snapshot's sections, reports the total, and plans detection over everything", async () => {
		const result = await prepareGlossyBuildActivity(INPUT);

		expect(result).toEqual({
			documentType: "PROPOSAL",
			sectionKeys: [EXEC, APPROACH, TEAM],
			slots: [{ slotId: "slot-1", sectionKey: EXEC, kind: "timeline" }],
			opportunities: [],
			detection: { sectionKeys: [EXEC, APPROACH, TEAM], limit: 8 },
		});
		expect(database.heartbeatGlossyBuild).toHaveBeenCalledWith("build-1", {
			step: "preparing",
			sectionsDone: 0,
			sectionsTotal: 3,
		});
		// Model resolution runs as the editor, inside the build's organization.
		expect(model.resolveGlossyModel).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			projectId: "proj-1",
		});
		expect(database.isFeatureEnabled).toHaveBeenCalledWith(
			"GLOSSY_EDITION",
			"org-1",
		);
		expect(database.canEditProject).toHaveBeenCalledWith(
			"proj-1",
			"user-1",
		);
	});

	it("returns keys and kinds only, never section text", async () => {
		const result = await prepareGlossyBuildActivity(INPUT);
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("Example Org");
		expect(serialized).not.toContain("phases");
		expect(serialized).not.toContain("graph TD");
	});
});

describe("prepareGlossyBuildActivity — refusals", () => {
	it("refuses a deleted document", async () => {
		db.projectDocument.findUnique.mockResolvedValue(null);
		await expect(prepareGlossyBuildActivity(INPUT)).rejects.toEqual(
			verdict("SOURCE_DOCUMENT_DELETED"),
		);
		expect(database.heartbeatGlossyBuild).not.toHaveBeenCalled();
	});

	it("refuses a document whose project is in the trash", async () => {
		db.projectDocument.findUnique.mockResolvedValue(
			documentRow({
				project: {
					organizationId: "org-1",
					deletedAt: new Date("2026-09-24T09:00:00.000Z"),
				},
			}),
		);
		await expect(prepareGlossyBuildActivity(INPUT)).rejects.toEqual(
			verdict("SOURCE_DOCUMENT_DELETED"),
		);
	});

	it("refuses a starter who lost edit access", async () => {
		database.canEditProject.mockResolvedValue(false);
		await expect(prepareGlossyBuildActivity(INPUT)).rejects.toEqual(
			verdict("ACCESS_REVOKED"),
		);
		expect(database.heartbeatGlossyBuild).not.toHaveBeenCalled();
		expect(model.resolveGlossyModel).not.toHaveBeenCalled();
	});

	it.each([
		["the document", { organizationId: "org-2" }],
		[
			"the project",
			{ project: { organizationId: "org-2", deletedAt: null } },
		],
		["the project id", { projectId: "proj-2" }],
	])(
		"refuses when %s no longer matches the build",
		async (_label, override) => {
			db.projectDocument.findUnique.mockResolvedValue(
				documentRow(override),
			);
			await expect(prepareGlossyBuildActivity(INPUT)).rejects.toEqual(
				verdict("ACCESS_REVOKED"),
			);
		},
	);

	it("refuses when the attempt names another editor", async () => {
		database.getGlossyBuildSnapshot.mockResolvedValue(
			snapshotOf(DOCUMENT, { startedById: null }),
		);
		await expect(prepareGlossyBuildActivity(INPUT)).rejects.toEqual(
			verdict("ACCESS_REVOKED"),
		);
	});

	it.each(["GENERATING", "QUEUED"])(
		"refuses a document mid-generation (%s)",
		async (status) => {
			db.projectDocument.findUnique.mockResolvedValue(
				documentRow({ status }),
			);
			await expect(prepareGlossyBuildActivity(INPUT)).rejects.toEqual(
				verdict("NOT_ELIGIBLE"),
			);
		},
	);

	it("refuses an ineligible document type", async () => {
		db.projectDocument.findUnique.mockResolvedValue(
			documentRow({ type: "PRD" }),
		);
		await expect(prepareGlossyBuildActivity(INPUT)).rejects.toEqual(
			verdict("NOT_ELIGIBLE"),
		);
	});

	it("refuses when the rollout gate is off for the organization", async () => {
		database.isFeatureEnabled.mockResolvedValue(false);
		await expect(prepareGlossyBuildActivity(INPUT)).rejects.toEqual(
			verdict("NOT_ELIGIBLE"),
		);
	});

	it("ends an all-TBD document with NOTHING_TO_PRESENT", async () => {
		database.getGlossyBuildSnapshot.mockResolvedValue(
			snapshotOf("# Title\n\n## Owner\n\nTBD\n\n## Budget\n\nTBD\n"),
		);
		await expect(prepareGlossyBuildActivity(INPUT)).rejects.toEqual(
			verdict("NOTHING_TO_PRESENT"),
		);
		expect(model.resolveGlossyModel).not.toHaveBeenCalled();
	});

	it("fails fast when no AI provider is configured (AE6)", async () => {
		model.resolveGlossyModel.mockResolvedValue({
			status: "aiProviderNotConfigured",
			message: "Configure an AI provider.",
		});
		await expect(prepareGlossyBuildActivity(INPUT)).rejects.toEqual(
			verdict("AI_PROVIDER_NOT_CONFIGURED"),
		);
	});

	it("stops as superseded when the attempt no longer holds the claim", async () => {
		database.heartbeatGlossyBuild.mockResolvedValue("superseded");
		await expect(prepareGlossyBuildActivity(INPUT)).rejects.toEqual(
			verdict("SUPERSEDED"),
		);
		expect(database.markGlossyBuildSuperseded).toHaveBeenCalledWith(
			"build-1",
		);
		expect(model.resolveGlossyModel).not.toHaveBeenCalled();
	});

	it("stops as superseded when its attempt is no longer building", async () => {
		database.getGlossyBuildSnapshot.mockResolvedValue(
			snapshotOf(DOCUMENT, { status: "SUPERSEDED" }),
		);
		await expect(prepareGlossyBuildActivity(INPUT)).rejects.toEqual(
			verdict("SUPERSEDED"),
		);
		expect(database.heartbeatGlossyBuild).not.toHaveBeenCalled();
	});
});

describe("prepareGlossyBuildActivity — rebuilds and Align first", () => {
	it("pins unchanged sections' visuals and detects only over the changed section (AE3)", async () => {
		// The published edition had the same Executive Summary and Team, an
		// Approach whose text has since changed, and a detected org chart
		// under Team.
		db.glossyEdition.findUnique.mockResolvedValue({
			content: editionContent({
				sections: [EXEC, "approach-before-the-edit", TEAM].map(
					(sectionKey) => ({
						sectionKey,
						headingPath: [],
						heading: null,
						level: 2,
						markdown: "text",
						wording: "rewritten" as const,
						anchors:
							sectionKey === TEAM
								? [
										{
											blockIndex: 1,
											ref: {
												type: "visual" as const,
												visualKey: "vk-team",
											},
										},
									]
								: [],
					}),
				),
				visuals: {
					"vk-team": {
						kind: "org_chart",
						spec: {
							kind: "org_chart",
							nodes: [
								{ id: "a", label: "Alex", parentId: null },
								{ id: "s", label: "Sam", parentId: "a" },
							],
						},
						specHash: "hash",
						source: "detected",
						reason: "Roles and ownership",
					},
				},
			}),
		});

		const result = await prepareGlossyBuildActivity(INPUT);

		expect(result.opportunities).toEqual([
			{ sectionKey: TEAM, kind: "org_chart" },
		]);
		expect(result.detection).toEqual({ sectionKeys: [APPROACH], limit: 7 });
	});

	it("detects nothing on a rebuild whose sections are all unchanged", async () => {
		// Stored before detection coverage was recorded: every section of such
		// an edition counts as detected, as it always did.
		db.glossyEdition.findUnique.mockResolvedValue({
			content: editionContent({
				sections: [EXEC, APPROACH, TEAM].map((sectionKey) => ({
					sectionKey,
					headingPath: [],
					heading: null,
					level: 2,
					markdown: "text",
					wording: "rewritten" as const,
					anchors: [],
				})),
			}),
		});

		const result = await prepareGlossyBuildActivity(INPUT);

		expect(result.detection).toBeNull();
		expect(result.opportunities).toEqual([]);
	});

	it("detects again over every section a degraded detection never covered", async () => {
		// The first build's one detection call degraded: it published every
		// section with no detected visual, and recorded none as covered.
		db.glossyEdition.findUnique.mockResolvedValue({
			content: editionContent({
				sections: publishedSections([EXEC, APPROACH, TEAM]),
				report: {
					...editionContent().report,
					detectedSectionKeys: [],
				},
			}),
		});

		const result = await prepareGlossyBuildActivity(INPUT);

		expect(result.opportunities).toEqual([]);
		expect(result.detection).toEqual({
			sectionKeys: [EXEC, APPROACH, TEAM],
			limit: 8,
		});
	});

	it("detects only over the uncovered sections; a section showing a detected visual stays pinned", async () => {
		// Covered: Executive Summary. Team shows a detected org chart, which
		// pins it even though the record leaves it out.
		db.glossyEdition.findUnique.mockResolvedValue({
			content: editionContent({
				sections: publishedSections([EXEC, APPROACH, TEAM], {
					[TEAM]: "vk-team",
				}),
				visuals: { "vk-team": TEAM_ORG_CHART },
				report: {
					...editionContent().report,
					detectedSectionKeys: [EXEC],
				},
			}),
		});

		const result = await prepareGlossyBuildActivity(INPUT);

		expect(result.opportunities).toEqual([
			{ sectionKey: TEAM, kind: "org_chart" },
		]);
		expect(result.detection).toEqual({ sectionKeys: [APPROACH], limit: 7 });
	});

	it("extracts exactly Align first's confirmed list and never detects", async () => {
		const result = await prepareGlossyBuildActivity({
			...INPUT,
			options: {
				mode: "align_first",
				lengthMode: "standard",
				confirmedOpportunities: [
					{ sectionKey: APPROACH, kind: "comparison" },
					{ sectionKey: TEAM, kind: "org_chart" },
					// Gone from the snapshot.
					{ sectionKey: "a-section-that-is-gone", kind: "stat" },
					// The slot of this section already asks for a timeline.
					{ sectionKey: EXEC, kind: "timeline" },
				],
			},
		});

		expect(result.opportunities).toEqual([
			{ sectionKey: APPROACH, kind: "comparison" },
			{ sectionKey: TEAM, kind: "org_chart" },
		]);
		expect(result.detection).toBeNull();
		expect(db.glossyEdition.findUnique).not.toHaveBeenCalled();
	});
});

describe("planGlossyVisuals", () => {
	const rollTheDice = normalizeBuildOptions({
		mode: "roll_the_dice",
		lengthMode: "brief",
	});

	it("keeps a best-fit slot's section out of detection, and a slot never costs budget", () => {
		const content = DOCUMENT.replace(
			"Alex leads delivery. Sam owns design.",
			'Alex leads delivery. Sam owns design.\n\n<visual-slot data-slot-id="slot-2" data-kind="" data-hint=""></visual-slot>',
		);
		const sections = sectionsOf(content);

		const plan = planGlossyVisuals({
			sections,
			options: rollTheDice,
			prior: null,
		});

		expect(plan.slots).toEqual([
			{ slotId: "slot-1", sectionKey: sections[0].key, kind: "timeline" },
			{ slotId: "slot-2", sectionKey: sections[2].key, kind: "auto" },
		]);
		expect(plan.detection).toEqual({
			sectionKeys: [sections[0].key, sections[1].key],
			limit: 8,
		});
	});

	it("fills a repeated slot id once", () => {
		const content = DOCUMENT.replace(
			'<visual-slot data-slot-id="slot-1" data-kind="timeline" data-hint="phases"></visual-slot>',
			'<visual-slot data-slot-id="slot-1" data-kind="timeline" data-hint="phases"></visual-slot>\n\n<visual-slot data-slot-id="slot-1" data-kind="stat" data-hint=""></visual-slot>',
		);
		const plan = planGlossyVisuals({
			sections: sectionsOf(content),
			options: rollTheDice,
			prior: null,
		});
		expect(plan.slots).toHaveLength(1);
	});
});
