/**
 * Shared fixtures for the Glossy build activity tests: one attempt, its
 * snapshot, and the keyed sections the real cleanup gives it. Every test file
 * mocks `@repo/database` and the model modules itself, before importing this.
 */

import type { GlossyBuildSnapshot } from "@repo/database";
import type { EditionContent } from "@repo/utils/glossy/edition-content";
import { expect } from "vitest";
import { cleanupSnapshot, keyGlossySections } from "../shared";

export const REF = {
	buildId: "build-1",
	documentId: "doc-1",
	projectId: "proj-1",
	organizationId: "org-1",
	startedById: "user-1",
} as const;

/**
 * Three sections: a key section with a timeline slot, one with an existing
 * Mermaid diagram and an uploaded image, and one plain section.
 */
export const DOCUMENT = [
	"# Example Proposal",
	"",
	"## Executive Summary",
	"",
	"We propose a pilot for Example Org costing $240k, starting Q3 2026.",
	"",
	'<visual-slot data-slot-id="slot-1" data-kind="timeline" data-hint="phases"></visual-slot>',
	"",
	"## Approach",
	"",
	"First we discover. Then we build.",
	"",
	"```mermaid",
	"graph TD; A-->B",
	"```",
	"",
	"Closing paragraph.",
	"",
	'<img data-s3-key="document-media/proj-1/abc.png" src="x">',
	"",
	"## Team",
	"",
	"Alex leads delivery. Sam owns design.",
].join("\n");

export function snapshotOf(
	content: string = DOCUMENT,
	overrides: Partial<GlossyBuildSnapshot> = {},
): GlossyBuildSnapshot {
	return {
		...REF,
		status: "BUILDING",
		startedAt: new Date("2026-09-24T10:00:00.000Z"),
		options: { mode: "roll_the_dice", lengthMode: "brief" },
		title: "Example Proposal",
		content,
		version: 7,
		contentHash: "hash-1",
		...overrides,
	};
}

/** The section keys a run of `content` works with, in document order. */
export function sectionsOf(content: string = DOCUMENT) {
	return keyGlossySections(
		cleanupSnapshot({ content, projectId: REF.projectId }, "PROPOSAL")
			.sections,
	);
}

/** A minimal valid published edition, for rebuild tests. */
export function editionContent(
	overrides: Partial<EditionContent> = {},
): EditionContent {
	return {
		title: "Example Proposal",
		pipelineVersion: "test",
		lengthMode: "brief",
		mode: "roll_the_dice",
		sections: [],
		visuals: {},
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
			sourceVersion: 6,
			builtAt: "2026-09-20T10:00:00.000Z",
		},
		...overrides,
	};
}

/** What an activity throws for a verdict: a non-retryable `ApplicationFailure` of that type. */
export function verdict(type: string) {
	return expect.objectContaining({ type, nonRetryable: true });
}
