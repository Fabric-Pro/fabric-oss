/**
 * What every Glossy build activity shares (Fizzy #2589): the attempt guard,
 * the typed failures, the snapshot's sections and their keys, and the shapes
 * of the segment cache rows.
 *
 * Not re-exported from the activities barrel: the worker registers every
 * function that barrel exports as an activity, and these are helpers.
 */

import {
	boundGlossyField,
	GLOSSY_DETECTABLE_KINDS,
	GLOSSY_PIPELINE_VERSION,
	GLOSSY_STYLE_DIRECTION_MAX_CHARS,
	type GlossyDetectableKind,
} from "@repo/agent-prompts/glossy";
import {
	db,
	type GlossyBuildProgress,
	type GlossyBuildSnapshot,
	type GlossyCacheKind,
	getCacheEntries,
	getGlossyBuildSnapshot,
	heartbeatGlossyBuild,
	markGlossyBuildSuperseded,
	type Prisma,
} from "@repo/database";
import {
	cleanupDocument,
	type GlossyAnchor,
	type GlossyCleanupResult,
	type GlossySection,
} from "@repo/utils/glossy/cleanup";
import {
	type EditionContent,
	editionContentSchema,
} from "@repo/utils/glossy/edition-content";
import type { GlossyEligibleDocumentType } from "@repo/utils/glossy/eligibility";
import {
	computeDetectedVisualKey,
	computeDetectionKey,
	computeExtractionKey,
	computeSectionKey,
	computeSlotVisualKey,
	type GlossyKeySlot,
} from "@repo/utils/glossy/keys";
import { visualSpecSchema } from "@repo/utils/glossy/visual-spec";
import { ApplicationFailure, Context } from "@temporalio/activity";
import { z } from "zod";
import type {
	GlossyExtractedVisualSpec,
	GlossyExtractionDropReason,
} from "../../lib/glossy/extract-visual";
import { GLOSSY_AI_PROVIDER_NOT_CONFIGURED_MESSAGE } from "../../lib/glossy/model";
import type { GlossyBuildNonRetryableErrorType } from "../../workflows/ai-non-retryable-errors";
import type {
	GlossyBuildErrorCode,
	GlossyBuildExtractKind,
	GlossyBuildLengthMode,
	GlossyBuildMode,
	GlossyBuildOptions,
	GlossyBuildRef,
	GlossyOpportunityRef,
	GlossyVisualDropReason,
} from "./types";

export const GLOSSY_BUILD_LOG = "[GlossyBuild]";

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * The message persisted with each code (KTD24). Fixed text only: a failure's
 * own message can carry document text, a provider URL, or a key, so it is
 * never written to the attempt.
 */
export const GLOSSY_BUILD_FAILURE_MESSAGES: Readonly<
	Record<GlossyBuildErrorCode, string>
> = {
	AI_PROVIDER_NOT_CONFIGURED: GLOSSY_AI_PROVIDER_NOT_CONFIGURED_MESSAGE,
	SOURCE_DOCUMENT_DELETED:
		"The source document was deleted before the build finished.",
	ACCESS_REVOKED:
		"The editor who started this build can no longer edit the document.",
	NOTHING_TO_PRESENT:
		"Nothing is left to present once the document's internal scaffolding is removed.",
	NOT_ELIGIBLE: "This document cannot be built into a Glossy edition now.",
	SUPERSEDED: "A newer build replaced this one.",
	BUILD_FAILED: "The Glossy edition could not be built. Try again.",
	// Written by `releaseGlossyClaim` (@repo/database), not by an activity;
	// the same text, so the row reads alike whichever side wrote it.
	WORKFLOW_START_FAILED: "The build could not be started.",
};

/** A verdict no retry can change: thrown non-retryable, typed by its code. */
export function glossyFailure(
	code: GlossyBuildNonRetryableErrorType,
): ApplicationFailure {
	return ApplicationFailure.nonRetryable(
		GLOSSY_BUILD_FAILURE_MESSAGES[code],
		code,
	);
}

/**
 * The snapshot and the code disagree — a section key prepare issued is not in
 * the same snapshot's cleanup, which only a deploy changing cleanup mid-build
 * can cause. No retry fixes that; the workflow records it as `BUILD_FAILED`.
 */
export function glossyInconsistency(message: string): ApplicationFailure {
	return ApplicationFailure.nonRetryable(
		message,
		"GLOSSY_BUILD_INCONSISTENT",
	);
}

/**
 * The run lost its claim: mark its own attempt superseded (a no-op when the
 * write that took the claim already did) and stop. Nothing else is written.
 */
export async function stopSuperseded(buildId: string): Promise<never> {
	await markGlossyBuildSuperseded(buildId);
	throw glossyFailure("SUPERSEDED");
}

function prismaCode(error: unknown): string | undefined {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : undefined;
}

/**
 * Map what a write racing the document's deletion throws. A foreign-key
 * violation (P2003) or a vanished row (P2025) means the source is gone; the
 * tenant error means the rows and the build disagree about their tenant.
 */
export async function withSourceErrors<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		const code = prismaCode(error);
		if (code === "P2003" || code === "P2025") {
			throw glossyFailure("SOURCE_DOCUMENT_DELETED");
		}
		if ((error as Error | null)?.name === "GlossyEditionTenantError") {
			throw glossyFailure("ACCESS_REVOKED");
		}
		throw error;
	}
}

/**
 * Check the claim before any model call, and record progress through the
 * same guarded write (KTD4). Stops the run when the claim moved.
 */
export async function guardBuild(
	buildId: string,
	progress: GlossyBuildProgress,
): Promise<void> {
	const outcome = await withSourceErrors(() =>
		heartbeatGlossyBuild(buildId, progress),
	);
	if (outcome === "superseded") {
		await stopSuperseded(buildId);
	}
}

/** This attempt's cancellation signal; `undefined` outside an activity (unit tests). */
export function currentCancellationSignal(): AbortSignal | undefined {
	try {
		return Context.current().cancellationSignal;
	} catch {
		return undefined;
	}
}

/** Every model call runs as the editor who started the build, in the project's organization (KTD21). */
export function glossyModelContext(ref: GlossyBuildRef) {
	return {
		userId: ref.startedById,
		organizationId: ref.organizationId,
		projectId: ref.projectId,
		abortSignal: currentCancellationSignal(),
	};
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface NormalizedGlossyBuildOptions {
	mode: GlossyBuildMode;
	lengthMode: GlossyBuildLengthMode;
	styleDirection: string | null;
	confirmedOpportunities: GlossyOpportunityRef[];
}

const DETECTABLE = new Set<string>(GLOSSY_DETECTABLE_KINDS);

export function isDetectableKind(kind: unknown): kind is GlossyDetectableKind {
	return typeof kind === "string" && DETECTABLE.has(kind);
}

/**
 * The options as the build uses them. The procedure validated them already;
 * this only makes an unexpected value fall back to the default instead of
 * reaching a prompt or a cache key.
 */
export function normalizeBuildOptions(
	options: GlossyBuildOptions | null | undefined,
): NormalizedGlossyBuildOptions {
	const confirmed = Array.isArray(options?.confirmedOpportunities)
		? options.confirmedOpportunities
		: [];
	return {
		mode: options?.mode === "align_first" ? "align_first" : "roll_the_dice",
		lengthMode: options?.lengthMode === "standard" ? "standard" : "brief",
		styleDirection: boundGlossyField(
			options?.styleDirection,
			GLOSSY_STYLE_DIRECTION_MAX_CHARS,
		),
		confirmedOpportunities: confirmed.filter(
			(entry): entry is GlossyOpportunityRef =>
				typeof entry?.sectionKey === "string" &&
				isDetectableKind(entry.kind),
		),
	};
}

/**
 * Visual kinds rendered as diagrams. A section that already holds a Mermaid
 * diagram shows one of them, so detection never proposes them there.
 */
const DIAGRAM_KINDS: readonly GlossyDetectableKind[] = [
	"timeline",
	"flow",
	"org_chart",
];

/**
 * Kinds a section already shows (R17, KTD9): a slot's explicit kind — slots
 * override detection for their section and kind — and the diagram kinds
 * when it holds an existing Mermaid diagram.
 */
export function reservedKinds(
	section: Pick<GlossySection, "anchors">,
): Set<GlossyDetectableKind> {
	const kinds = new Set<GlossyDetectableKind>();
	for (const anchor of section.anchors) {
		if (anchor.kind === "mermaid") {
			for (const kind of DIAGRAM_KINDS) {
				kinds.add(kind);
			}
		} else if (
			anchor.kind === "slot" &&
			isDetectableKind(anchor.slotKind)
		) {
			kinds.add(anchor.slotKind);
		}
	}
	return kinds;
}

/** A slot's requested kind, or `auto` for best fit and for anything unexpected. */
export function slotExtractKind(
	slotKind: string | null,
): GlossyBuildExtractKind {
	return isDetectableKind(slotKind) ? slotKind : "auto";
}

// ---------------------------------------------------------------------------
// Snapshot and sections
// ---------------------------------------------------------------------------

export interface GlossyKeyedSection {
	/** `computeSectionKey` of the cleaned section (KTD7). */
	key: string;
	section: GlossySection;
}

/** Key every main-flow section, in document order. */
export function keyGlossySections(
	sections: readonly GlossySection[],
): GlossyKeyedSection[] {
	return sections.map((section) => ({
		key: computeSectionKey({
			headingPath: section.headingPath,
			occurrenceIndex: section.occurrenceIndex,
			markdown: section.markdown,
			pipelineVersion: GLOSSY_PIPELINE_VERSION,
		}),
		section,
	}));
}

/** Cleanup of one snapshot. Pure, so every activity of the run sees the same sections. */
export function cleanupSnapshot(
	snapshot: Pick<GlossyBuildSnapshot, "content" | "projectId">,
	documentType: GlossyEligibleDocumentType,
): GlossyCleanupResult {
	return cleanupDocument(snapshot.content, documentType, {
		projectId: snapshot.projectId,
	});
}

/** The build's attempt row must name the same document, tenant, and editor as the run. */
export function snapshotMatchesRef(
	snapshot: GlossyBuildSnapshot,
	ref: GlossyBuildRef,
): boolean {
	return (
		snapshot.buildId === ref.buildId &&
		snapshot.documentId === ref.documentId &&
		snapshot.projectId === ref.projectId &&
		snapshot.organizationId === ref.organizationId &&
		snapshot.startedById === ref.startedById
	);
}

export interface GlossyBuildSource {
	snapshot: GlossyBuildSnapshot;
	cleanup: GlossyCleanupResult;
	sections: GlossyKeyedSection[];
}

/**
 * The run's own snapshot, cleaned and keyed. Each run reads only its own
 * snapshot, never the live document (KTD6); an attempt that is no longer
 * BUILDING has lost its claim.
 */
export async function loadBuildSource(
	ref: GlossyBuildRef,
	documentType: GlossyEligibleDocumentType,
): Promise<GlossyBuildSource> {
	const snapshot = await getGlossyBuildSnapshot(ref.buildId);
	if (!snapshot || snapshot.status !== "BUILDING") {
		return stopSuperseded(ref.buildId);
	}
	if (!snapshotMatchesRef(snapshot, ref)) {
		throw glossyFailure("ACCESS_REVOKED");
	}
	const { cleanup, sections } = planGlossyKeys({
		content: snapshot.content,
		projectId: snapshot.projectId,
		documentType,
	});
	return { snapshot, cleanup, sections };
}

export function requireSection(
	source: GlossyBuildSource,
	sectionKey: string,
): GlossyKeyedSection {
	const found = source.sections.find((entry) => entry.key === sectionKey);
	if (!found) {
		throw glossyInconsistency(
			"A section the build planned is not in its snapshot",
		);
	}
	return found;
}

/**
 * The detection cache key (KTD8): the ordered keys of the sections detection
 * considers and the slots in them. Align-first detection over the whole
 * document keys the same way, so a first build after it is a cache hit.
 */
export function glossyDetectionKey(
	sections: readonly GlossyKeyedSection[],
	documentType: GlossyEligibleDocumentType,
): string {
	const slots: GlossyKeySlot[] = sections.flatMap(({ section }) =>
		section.anchors.flatMap((anchor) =>
			anchor.kind === "slot"
				? [
						{
							id: anchor.slotId,
							kind: anchor.slotKind,
							hint: anchor.hint,
						},
					]
				: [],
		),
	);
	return computeDetectionKey({
		sectionKeys: sections.map((entry) => entry.key),
		slots,
		documentType,
		pipelineVersion: GLOSSY_PIPELINE_VERSION,
	});
}

/** A section detection may propose a visual for, as the model call takes it. */
export interface GlossyDetectableSection {
	sectionKey: string;
	heading: string | null;
	/** The cleaned section body. */
	markdown: string;
	/** Kinds the section already shows through a slot or an existing diagram. */
	reservedKinds: GlossyDetectableKind[];
}

/** The keys one source body yields — the build's and the request's alike. */
export interface GlossyKeyPlan {
	cleanup: GlossyCleanupResult;
	/** Every main-flow section, keyed, in document order. */
	sections: GlossyKeyedSection[];
	/** Their keys, in document order: what Align first's confirmed opportunities name. */
	sectionKeys: string[];
	/**
	 * The detection key over every section, slots included: the row
	 * Align-first detection writes and finalize reads the confirmed
	 * opportunities' reasons from (KTD10). A first Roll-the-dice build
	 * detecting over the same sections computes the same key.
	 */
	detectionKey: string;
	/**
	 * The sections a whole-document detection proposes for, in document
	 * order. A section holding a best-fit slot is left out, as the build's
	 * own detection leaves it out (`planGlossyVisuals`): the slot may resolve
	 * to any kind, and two visuals of one kind side by side is the risk.
	 */
	detectable: GlossyDetectableSection[];
}

/**
 * THE key plan of a source body (Fizzy #2589, KTD7, KTD8, KTD10): cleanup
 * with the project's own-image rule, the section keys, and the whole-document
 * detection key.
 *
 * One function for both sides of Align first. The build reaches it through
 * `loadBuildSource` for every activity of a run; the detect and build
 * procedures call it on the live document through the package's root barrel.
 * A second copy of these steps would drift — a different cleanup option or
 * section filter re-keys everything — and the cost of drift is silent:
 * `planGlossyVisuals` drops every confirmed opportunity whose section key the
 * build does not know, and finalize finds no reasons under a detection key
 * nobody wrote.
 */
export function planGlossyKeys(input: {
	content: string;
	projectId: string;
	documentType: GlossyEligibleDocumentType;
}): GlossyKeyPlan {
	const cleanup = cleanupSnapshot(
		{ content: input.content, projectId: input.projectId },
		input.documentType,
	);
	const sections = keyGlossySections(cleanup.sections);
	const detectable: GlossyDetectableSection[] = [];
	for (const { key, section } of sections) {
		const bestFit = section.anchors.some(
			(anchor) =>
				anchor.kind === "slot" &&
				slotExtractKind(anchor.slotKind) === "auto",
		);
		if (bestFit) {
			continue;
		}
		detectable.push({
			sectionKey: key,
			heading: section.heading,
			markdown: section.markdown,
			reservedKinds: [...reservedKinds(section)],
		});
	}
	return {
		cleanup,
		sections,
		sectionKeys: sections.map((entry) => entry.key),
		detectionKey: glossyDetectionKey(sections, input.documentType),
		detectable,
	};
}

// ---------------------------------------------------------------------------
// One visual's extraction (the build's extract activity and regenerate)
// ---------------------------------------------------------------------------

export type GlossySlotAnchor = Extract<GlossyAnchor, { kind: "slot" }>;

/**
 * The slot a build fills for `slotId`: the first one in the section with
 * that id. Prepare plans one extraction per slot id and section, and a
 * repeat is reported unfilled, so the first is the one that was filled.
 */
export function findGlossySlot(
	section: Pick<GlossySection, "anchors">,
	slotId: string,
): GlossySlotAnchor | null {
	for (const anchor of section.anchors) {
		if (anchor.kind === "slot" && anchor.slotId === slotId) {
			return anchor;
		}
	}
	return null;
}

/** The edition's key for an extracted visual (KTD8): a slot's, or an opportunity's. */
export function glossyExtractedVisualKey(input: {
	sectionKey: string;
	slotId: string | null;
	kind: string;
}): string {
	return input.slotId !== null
		? computeSlotVisualKey({
				slotId: input.slotId,
				sectionKey: input.sectionKey,
				pipelineVersion: GLOSSY_PIPELINE_VERSION,
			})
		: computeDetectedVisualKey({
				sectionKey: input.sectionKey,
				kind: input.kind,
				pipelineVersion: GLOSSY_PIPELINE_VERSION,
			});
}

/** What an extraction asks the model for, and the cache row its spec lives under. */
export interface GlossyExtractionTarget {
	/** What the build asks for: the opportunity's kind, or a slot's own kind or `auto`. */
	kind: GlossyBuildExtractKind;
	/** The slot's hint from the snapshot; `null` for an opportunity. */
	slotHint: string | null;
	/** Bounded, as the prompt receives it. */
	styleDirection: string | null;
	/**
	 * The EXTRACTION row: section key, kind, slot hint, style direction,
	 * pipeline version, and for a slot its id.
	 */
	cacheKey: string;
}

/**
 * THE extraction cache key of one visual (KTD8, KTD10). The build's extract
 * activity reads and writes its spec under this key, and single-visual
 * regenerate writes the replacement under the same one. That is what makes a
 * regenerate stick: a later rebuild of the unchanged section finds the
 * regenerated spec here and reuses it. A regenerate cached under any other
 * key would leave the original spec in place, and the rebuild would silently
 * restore it, taking the regenerated visual and its review with it.
 *
 * `styleDirection` is the raw value the build ran with — the workflow's
 * `options.styleDirection`, which the claim also recorded on the attempt — and
 * is bounded here, once, for both callers.
 *
 * `slotId` is the slot's for a slot's visual and `null` for an opportunity:
 * two hintless slots of one kind in a section would otherwise share one row,
 * and so one spec, and regenerating either would replace both.
 */
export function glossyExtractionTarget(input: {
	sectionKey: string;
	kind: GlossyBuildExtractKind;
	slotId: string | null;
	slotHint: string | null;
	styleDirection: string | null | undefined;
}): GlossyExtractionTarget {
	const styleDirection = boundGlossyField(
		input.styleDirection,
		GLOSSY_STYLE_DIRECTION_MAX_CHARS,
	);
	return {
		kind: input.kind,
		slotHint: input.slotHint,
		styleDirection,
		cacheKey: computeExtractionKey({
			sectionKey: input.sectionKey,
			kind: input.kind,
			slotHint: input.slotHint,
			styleDirection,
			slotId: input.slotId,
			pipelineVersion: GLOSSY_PIPELINE_VERSION,
		}),
	};
}

/** Where a single-visual regenerate reads from and writes to. */
export interface GlossyRegenerationPlan extends GlossyExtractionTarget {
	sectionKey: string;
	visualKey: string;
	/** Set for a slot's visual. */
	slotId: string | null;
	/**
	 * The kind to ask the model for: the visual's own (R27, same kind). For a
	 * best-fit slot this is the kind it resolved to, while `kind` — and so the
	 * cache key — stays `auto`, as the build keys it.
	 */
	requestKind: GlossyDetectableKind;
}

/**
 * Which extraction of a published build produced `visualKey`, keyed exactly
 * as that build keyed it (KTD10): the request-side twin of prepare plus the
 * extract activity, for single-visual regenerate.
 *
 * `section` is the visual's section in the published attempt's own snapshot
 * (`planGlossyKeys` over it), and `buildOptions` the options that attempt
 * recorded. A detected visual is re-keyed from its section and kind; a
 * slot's visual from the slot in that section whose key it is, with the
 * slot's own kind (`slotExtractKind`, as prepare computes it) and hint.
 *
 * `null` when the snapshot does not produce this visual key — the edition
 * came from different keying rules — or for an existing diagram, which is
 * restyled, not extracted.
 */
export function planGlossyRegeneration(input: {
	sectionKey: string;
	section: Pick<GlossySection, "anchors">;
	visualKey: string;
	visual: { source: string; kind: string };
	buildOptions: unknown;
}): GlossyRegenerationPlan | null {
	const { sectionKey, section, visualKey, visual } = input;
	if (!isDetectableKind(visual.kind)) {
		return null;
	}
	const styleDirection = recordedStyleDirection(input.buildOptions);

	if (visual.source === "detected") {
		if (
			glossyExtractedVisualKey({
				sectionKey,
				slotId: null,
				kind: visual.kind,
			}) !== visualKey
		) {
			return null;
		}
		return {
			...glossyExtractionTarget({
				sectionKey,
				kind: visual.kind,
				slotId: null,
				slotHint: null,
				styleDirection,
			}),
			sectionKey,
			visualKey,
			slotId: null,
			requestKind: visual.kind,
		};
	}

	if (visual.source === "slot") {
		for (const anchor of section.anchors) {
			if (
				anchor.kind !== "slot" ||
				glossyExtractedVisualKey({
					sectionKey,
					slotId: anchor.slotId,
					kind: visual.kind,
				}) !== visualKey
			) {
				continue;
			}
			const kind = slotExtractKind(anchor.slotKind);
			// A slot that asks for one kind holds only that kind.
			if (kind !== "auto" && kind !== visual.kind) {
				return null;
			}
			return {
				...glossyExtractionTarget({
					sectionKey,
					kind,
					slotId: anchor.slotId,
					slotHint: anchor.hint,
					styleDirection,
				}),
				sectionKey,
				visualKey,
				slotId: anchor.slotId,
				requestKind: visual.kind,
			};
		}
	}
	return null;
}

/** The raw style direction an attempt recorded: what its workflow ran with. */
function recordedStyleDirection(options: unknown): string | null {
	const value = (options as { styleDirection?: unknown } | null)
		?.styleDirection;
	return typeof value === "string" ? value : null;
}

// ---------------------------------------------------------------------------
// The published edition (rebuilds)
// ---------------------------------------------------------------------------

export function opportunityId(sectionKey: string, kind: string): string {
	return `${sectionKey}\u0000${kind}`;
}

export interface PriorDetectedVisuals {
	/**
	 * Section keys of the published edition whose detection is settled: the
	 * ones its detection covered (`report.detectedSectionKeys`, or every
	 * section of an edition stored before that was recorded), and any section
	 * showing a detected visual. A rebuild detects over the rest again.
	 */
	sectionKeys: Set<string>;
	/** Its detected visuals as opportunities, in document order. */
	opportunities: GlossyOpportunityRef[];
	/** Their detection reasons, by `opportunityId`. */
	reasons: Map<string, string>;
}

const NO_PRIOR: PriorDetectedVisuals = {
	sectionKeys: new Set(),
	opportunities: [],
	reasons: new Map(),
};

/**
 * The published edition's detected visuals, which a rebuild pins for the
 * sections whose text is unchanged (KTD9), and the sections whose detection
 * it settled. A section a degraded detection never covered is left out, so
 * the next Roll-the-dice build detects over it again. A pipeline version
 * change re-keys every section, so nothing is pinned across one. No edition,
 * or content that no longer parses, pins nothing.
 */
export async function readPriorDetectedVisuals(
	documentId: string,
): Promise<PriorDetectedVisuals> {
	const edition = await db.glossyEdition.findUnique({
		where: { documentId },
		select: { content: true },
	});
	if (!edition?.content) {
		return NO_PRIOR;
	}
	const parsed = editionContentSchema.safeParse(edition.content);
	if (!parsed.success) {
		return NO_PRIOR;
	}
	return priorDetectedVisuals(parsed.data);
}

export function priorDetectedVisuals(
	content: EditionContent,
): PriorDetectedVisuals {
	const recorded = content.report.detectedSectionKeys;
	const covered = recorded ? new Set(recorded) : null;
	const sectionKeys = new Set<string>();
	const opportunities: GlossyOpportunityRef[] = [];
	const reasons = new Map<string, string>();
	for (const section of content.sections) {
		if (!covered || covered.has(section.sectionKey)) {
			sectionKeys.add(section.sectionKey);
		}
		for (const anchor of section.anchors) {
			if (anchor.ref.type !== "visual") {
				continue;
			}
			const visual = content.visuals[anchor.ref.visualKey];
			if (
				visual?.source !== "detected" ||
				!isDetectableKind(visual.kind)
			) {
				continue;
			}
			// A section showing a detected visual stays pinned: detecting over
			// it again could stack a second visual beside the pinned one.
			sectionKeys.add(section.sectionKey);
			const id = opportunityId(section.sectionKey, visual.kind);
			if (reasons.has(id)) {
				continue;
			}
			opportunities.push({
				sectionKey: section.sectionKey,
				kind: visual.kind,
			});
			reasons.set(id, visual.reason ?? "");
		}
	}
	return { sectionKeys, opportunities, reasons };
}

// ---------------------------------------------------------------------------
// Segment cache rows
// ---------------------------------------------------------------------------

// Type aliases rather than interfaces, so each stays assignable to Prisma's
// JSON input type.

/** A rewrite cache row: a guarded success (KTD8). */
export type GlossyRewriteCacheOutput = { markdown: string };

/** An extraction cache row; single-visual regenerate writes the same shape. */
export type GlossyExtractionCacheOutput = { spec: GlossyExtractedVisualSpec };

/** A detection cache row; Align-first detection in the request writes the same shape. */
export type GlossyDetectionCacheOutput = {
	opportunities: Array<{
		sectionKey: string;
		kind: GlossyDetectableKind;
		reason: string;
	}>;
};

/** The stored output of one cache row, or `undefined` when there is none. */
export async function readGlossyCacheEntry(input: {
	documentId: string;
	kind: GlossyCacheKind;
	cacheKey: string;
}): Promise<Prisma.JsonValue | undefined> {
	const rows = await getCacheEntries({
		documentId: input.documentId,
		kind: input.kind,
		cacheKeys: [input.cacheKey],
	});
	return rows.get(input.cacheKey);
}

const rewriteOutputSchema = z.object({ markdown: z.string() });

const detectionOutputSchema = z.object({
	opportunities: z.array(
		z.object({
			sectionKey: z.string(),
			kind: z.string(),
			reason: z.string().optional(),
		}),
	),
});

const VISUAL_DROP_REASONS: Readonly<
	Record<GlossyExtractionDropReason, GlossyVisualDropReason>
> = {
	truncated: "truncated",
	invalidSpec: "invalid_spec",
	kindMismatch: "kind_mismatch",
	factCheck: "fact_check",
};

/**
 * Why an extraction's result was not used, as the build report and a
 * refused regenerate both name it.
 */
export function glossyVisualDropReason(
	reason: GlossyExtractionDropReason,
): GlossyVisualDropReason {
	return VISUAL_DROP_REASONS[reason];
}

/** A row in a shape this code does not read counts as a miss, never as a failure. */
export function parseRewriteOutput(output: unknown): string | null {
	const parsed = rewriteOutputSchema.safeParse(output);
	return parsed.success ? parsed.data.markdown : null;
}

export function parseExtractionOutput(
	output: unknown,
): GlossyExtractedVisualSpec | null {
	const spec = (output as { spec?: unknown } | null)?.spec;
	const parsed = visualSpecSchema.safeParse(spec);
	if (!parsed.success || !isDetectableKind(parsed.data.kind)) {
		return null;
	}
	return parsed.data as GlossyExtractedVisualSpec;
}

export function parseDetectionOutput(
	output: unknown,
): GlossyDetectionCacheOutput["opportunities"] | null {
	const parsed = detectionOutputSchema.safeParse(output);
	if (!parsed.success) {
		return null;
	}
	return parsed.data.opportunities.flatMap((entry) =>
		isDetectableKind(entry.kind)
			? [
					{
						sectionKey: entry.sectionKey,
						kind: entry.kind,
						reason: entry.reason ?? "",
					},
				]
			: [],
	);
}
