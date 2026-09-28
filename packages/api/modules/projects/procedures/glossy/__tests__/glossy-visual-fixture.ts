/**
 * A published Glossy edition for the regenerate and review tests (Fizzy
 * #2589, U20): the build snapshot it came from, and its content, keyed by
 * the real `planGlossyKeys` over that snapshot — so a regenerate re-plans
 * exactly the sections the edition shows.
 *
 * Three visuals, one per way a build makes one:
 *  - a slot asking for a stat, with a hint, in the Executive Summary;
 *  - an existing Mermaid diagram in Approach (restyled, never extracted);
 *  - a detected org chart in Team.
 *
 * Imported statically by the test files, after their `vi.mock` calls, so
 * `@repo/temporal` here is the harness's mock over the real module.
 */

import { GLOSSY_PIPELINE_VERSION } from "@repo/agent-prompts/glossy";
import { planGlossyKeys } from "@repo/temporal";
import type {
	EditionContent,
	EditionVisual,
} from "@repo/utils/glossy/edition-content";
import {
	computeDetectedVisualKey,
	computeMermaidVisualKey,
	computeSlotVisualKey,
} from "@repo/utils/glossy/keys";
import { specHash, type VisualSpec } from "@repo/utils/glossy/visual-spec";
import {
	buildSummary,
	DOC_A,
	type EditionStore,
	ORG_A,
	PROJECT_A,
	USERS,
	useEditionStore,
} from "./glossy-harness";

export const PUBLISHED_BUILD_ID = "build-published";

/** The body the published build snapshotted; the live document may have moved on. */
const SNAPSHOT_BODY = [
	"# Example Proposal",
	"",
	"## Executive Summary",
	"",
	"We propose a pilot for Example Org costing $240k, starting Q3 2026.",
	"",
	'<visual-slot data-slot-id="slot-1" data-kind="stat" data-hint="the budget"></visual-slot>',
	"",
	"## Approach",
	"",
	"First we discover. Then we build and measure.",
	"",
	"```mermaid",
	"graph TD; Discover-->Build",
	"```",
	"",
	"## Team",
	"",
	"Alex leads delivery. Sam owns design.",
].join("\n");

/** What the published build recorded; the style direction shapes the extraction key. */
const PUBLISHED_OPTIONS = {
	mode: "align_first",
	lengthMode: "brief",
	styleDirection: "Calm",
	confirmedOpportunities: [],
	preparerOverrides: null,
};

const STAT = {
	kind: "stat",
	items: [{ value: "$240k", label: "Pilot" }],
} as const satisfies VisualSpec;

export const ORG_CHART = {
	kind: "org_chart",
	nodes: [
		{ id: "a", label: "Alex", parentId: null },
		{ id: "s", label: "Sam", parentId: "a" },
	],
} as const satisfies VisualSpec;

const MERMAID = {
	kind: "existing_mermaid",
	source: "graph TD; Discover-->Build",
} as const satisfies VisualSpec;

function visual(
	spec: VisualSpec,
	source: EditionVisual["source"],
	reason?: string,
): EditionVisual {
	return {
		kind: spec.kind,
		spec,
		specHash: specHash(spec),
		source,
		...(reason ? { reason } : {}),
	};
}

function publishedEdition() {
	const plan = planGlossyKeys({
		content: SNAPSHOT_BODY,
		projectId: PROJECT_A,
		documentType: "PROPOSAL",
	});
	const [exec, approach, team] = plan.sections;
	const keys = {
		exec: computeSlotVisualKey({
			slotId: "slot-1",
			sectionKey: exec.key,
			pipelineVersion: GLOSSY_PIPELINE_VERSION,
		}),
		mermaid: computeMermaidVisualKey({
			source: MERMAID.source,
			pipelineVersion: GLOSSY_PIPELINE_VERSION,
		}),
		team: computeDetectedVisualKey({
			sectionKey: team.key,
			kind: "org_chart",
			pipelineVersion: GLOSSY_PIPELINE_VERSION,
		}),
	};
	const anchorsOf: Record<string, string> = {
		[exec.key]: keys.exec,
		[approach.key]: keys.mermaid,
		[team.key]: keys.team,
	};
	const content: EditionContent = {
		title: "Example Proposal",
		pipelineVersion: GLOSSY_PIPELINE_VERSION,
		lengthMode: "brief",
		mode: "align_first",
		sections: plan.sections.map(({ key, section }) => ({
			sectionKey: key,
			headingPath: section.headingPath,
			heading: section.heading,
			level: section.level,
			markdown: section.markdown,
			wording: "original",
			anchors: [
				{
					blockIndex: 1,
					ref: { type: "visual", visualKey: anchorsOf[key] },
				},
			],
		})),
		visuals: {
			[keys.exec]: visual(STAT, "slot"),
			[keys.mermaid]: visual(MERMAID, "existing_mermaid"),
			[keys.team]: visual(ORG_CHART, "detected", "Roles and ownership"),
		},
		appendix: {
			sources: [],
			details: [],
			placeholders: [],
			assumptions: [],
			additionalMaterial: [],
		},
		report: {
			keptOriginal: [],
			droppedVisuals: [],
			unfilledSlots: [],
			scaffoldingUnrecognized: false,
		},
		provenance: {
			sourceTitle: "Example Proposal",
			sourceVersion: 5,
			builtAt: "2026-09-24T10:05:00.000Z",
		},
	};
	const snapshot = {
		buildId: PUBLISHED_BUILD_ID,
		documentId: DOC_A,
		projectId: PROJECT_A,
		organizationId: ORG_A,
		status: "SUCCEEDED",
		startedById: USERS.editor,
		startedAt: new Date("2026-09-24T10:00:00.000Z"),
		options: PUBLISHED_OPTIONS,
		title: "Example Proposal",
		content: SNAPSHOT_BODY,
		version: 5,
		contentHash: "0000000000000000",
	};
	return {
		keys,
		sections: { exec, approach, team },
		content,
		snapshot,
	};
}

/** One edition of `DOC_A`, published by {@link PUBLISHED_BUILD_ID} at revision 3. */
export function usePublishedEdition(overrides: Partial<EditionStore> = {}) {
	const fixture = publishedEdition();
	const store = useEditionStore({
		content: structuredClone(fixture.content),
		contentRevision: 3,
		publishedBuildId: PUBLISHED_BUILD_ID,
		builds: new Map([
			[PUBLISHED_BUILD_ID, buildSummary({ id: PUBLISHED_BUILD_ID })],
		]),
		snapshots: new Map([[PUBLISHED_BUILD_ID, fixture.snapshot]]),
		...overrides,
	});
	return { store, ...fixture };
}

/** A build holding the claim, started by `startedById`. */
export function claimBy(
	store: EditionStore,
	buildId: string,
	startedById: string = USERS.guestEditor,
): void {
	store.currentBuildId = buildId;
	store.builds.set(
		buildId,
		buildSummary({
			id: buildId,
			status: "BUILDING",
			startedById,
			startedAt: new Date("2026-09-24T12:00:00.000Z"),
			heartbeatAt: new Date(),
			finishedAt: null,
		}),
	);
}

/** Stored content, typed. */
export function storedContent(store: EditionStore): EditionContent {
	return store.content as EditionContent;
}
