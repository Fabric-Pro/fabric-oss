import { GLOSSY_MAX_OPPORTUNITIES } from "@repo/agent-prompts/glossy";
import {
	canEditProject,
	db,
	getGlossyBuildSnapshot,
	isFeatureEnabled,
} from "@repo/database";
import { isGlossyEligible } from "@repo/utils/glossy/eligibility";
import { resolveGlossyModel } from "../../lib/glossy/model";
import {
	cleanupSnapshot,
	GLOSSY_BUILD_LOG,
	type GlossyKeyedSection,
	glossyExtractedVisualKey,
	glossyFailure,
	guardBuild,
	keyGlossySections,
	type NormalizedGlossyBuildOptions,
	normalizeBuildOptions,
	opportunityId,
	type PriorDetectedVisuals,
	readPriorDetectedVisuals,
	reservedKinds,
	slotExtractKind,
	snapshotMatchesRef,
	stopSuperseded,
} from "./shared";
import type {
	GlossyBuildSlotRef,
	GlossyOpportunityRef,
	PrepareGlossyBuildInput,
	PrepareGlossyBuildResult,
} from "./types";

/**
 * First step of a Glossy build (Fizzy #2589, R3, R5, R10, KTD4, KTD9, KTD20).
 *
 * Re-checks everything the build procedure checked, because minutes may have
 * passed and a retried start may be hours late:
 *  - the document and its project still exist, the project is not in the
 *    trash, and both still belong to the build's organization and project;
 *  - the rollout gate is still on for that organization (KTD20 has no kill
 *    switch; this re-read is the brake);
 *  - the editor who started the build can still edit the project;
 *  - the document type is eligible and the document is not mid-generation.
 * Then it cleans the attempt's own snapshot, takes the claim's first guarded
 * write with the section count, resolves the model so a missing provider
 * fails before any work (AE6), and plans the visual work.
 *
 * Each refusal is a non-retryable failure typed by its code.
 */

/** Statuses of a document the generation workflow still owns (R3). */
const MID_GENERATION = new Set(["QUEUED", "GENERATING"]);

/** Visual kinds rendered as diagrams: a section that already holds a Mermaid diagram reserves them. */
export async function prepareGlossyBuildActivity(
	input: PrepareGlossyBuildInput,
): Promise<PrepareGlossyBuildResult> {
	const document = await db.projectDocument.findUnique({
		where: { id: input.documentId },
		select: {
			projectId: true,
			organizationId: true,
			type: true,
			status: true,
			project: { select: { organizationId: true, deletedAt: true } },
		},
	});
	if (!document || document.project.deletedAt) {
		throw glossyFailure("SOURCE_DOCUMENT_DELETED");
	}
	if (
		document.projectId !== input.projectId ||
		document.organizationId !== input.organizationId ||
		document.project.organizationId !== input.organizationId
	) {
		throw glossyFailure("ACCESS_REVOKED");
	}

	// The document exists, so a missing or finished attempt lost its claim.
	const snapshot = await getGlossyBuildSnapshot(input.buildId);
	if (!snapshot || snapshot.status !== "BUILDING") {
		return stopSuperseded(input.buildId);
	}
	if (!snapshotMatchesRef(snapshot, input)) {
		throw glossyFailure("ACCESS_REVOKED");
	}

	if (!(await isFeatureEnabled("GLOSSY_EDITION", input.organizationId))) {
		throw glossyFailure("NOT_ELIGIBLE");
	}
	if (!(await canEditProject(input.projectId, input.startedById))) {
		throw glossyFailure("ACCESS_REVOKED");
	}
	const documentType = document.type;
	if (
		!isGlossyEligible(documentType) ||
		MID_GENERATION.has(document.status)
	) {
		throw glossyFailure("NOT_ELIGIBLE");
	}

	const cleanup = cleanupSnapshot(snapshot, documentType);
	if (cleanup.nothingToPresent) {
		throw glossyFailure("NOTHING_TO_PRESENT");
	}
	const sections = keyGlossySections(cleanup.sections);

	await guardBuild(input.buildId, {
		step: "preparing",
		sectionsDone: 0,
		sectionsTotal: sections.length,
	});

	const model = await resolveGlossyModel({
		userId: input.startedById,
		organizationId: input.organizationId,
		projectId: input.projectId,
	});
	if (model.status !== "resolved") {
		throw glossyFailure("AI_PROVIDER_NOT_CONFIGURED");
	}

	const options = normalizeBuildOptions(input.options);
	const prior =
		options.mode === "roll_the_dice"
			? await readPriorDetectedVisuals(input.documentId)
			: null;
	const plan = planGlossyVisuals({ sections, options, prior });

	console.info(`${GLOSSY_BUILD_LOG} Prepared`, {
		buildId: input.buildId,
		mode: options.mode,
		sections: sections.length,
		slots: plan.slots.length,
		opportunities: plan.opportunities.length,
		detectOver: plan.detection?.sectionKeys.length ?? 0,
	});

	return {
		documentType,
		sectionKeys: sections.map((entry) => entry.key),
		...plan,
	};
}

/**
 * Which visuals the build extracts, and what detection still has to find
 * (R17, R22, KTD9, KTD10).
 *
 * - Slots are filled first and never count toward the eight-opportunity
 *   budget: that budget bounds what the model proposes, and a slot is an
 *   editor's explicit request. A slot overrides detection for its section
 *   and kind; a best-fit slot could resolve to any kind, so its section is
 *   left out of detection altogether rather than risk two visuals of one
 *   kind side by side.
 * - An existing Mermaid diagram becomes a visual without a model call and
 *   reserves the diagram kinds for its section.
 * - Align first extracts exactly the confirmed list and never detects.
 * - Roll the dice pins the published edition's detected visuals for
 *   sections whose text is unchanged — their key is unchanged — and detects
 *   only over the changed sections and those the published edition's
 *   detection never covered (it degraded, or no budget was left), within
 *   what is left of the budget. A first build detects over the whole
 *   document.
 */
export function planGlossyVisuals(input: {
	sections: readonly GlossyKeyedSection[];
	options: NormalizedGlossyBuildOptions;
	prior: PriorDetectedVisuals | null;
}): Omit<PrepareGlossyBuildResult, "documentType" | "sectionKeys"> {
	const { sections, options, prior } = input;
	const keys = new Set(sections.map((entry) => entry.key));

	const slots: GlossyBuildSlotRef[] = [];
	const slotVisualKeys = new Set<string>();
	/** Sections holding a best-fit slot: kept out of detection. */
	const bestFitSections = new Set<string>();
	/** Kinds a section already shows, by section key. */
	const reserved = new Map<string, Set<string>>();

	for (const { key, section } of sections) {
		reserved.set(key, reservedKinds(section));
		for (const anchor of section.anchors) {
			if (anchor.kind !== "slot") {
				continue;
			}
			const kind = slotExtractKind(anchor.slotKind);
			// A slot id repeated in one section would name one visual twice;
			// the first is filled and finalize reports the rest.
			const visualKey = glossyExtractedVisualKey({
				sectionKey: key,
				slotId: anchor.slotId,
				kind,
			});
			if (slotVisualKeys.has(visualKey)) {
				continue;
			}
			slotVisualKeys.add(visualKey);
			slots.push({ slotId: anchor.slotId, sectionKey: key, kind });
			if (kind === "auto") {
				bestFitSections.add(key);
			}
		}
	}

	const keep = (candidates: readonly GlossyOpportunityRef[]) => {
		const seen = new Set<string>();
		const kept: GlossyOpportunityRef[] = [];
		for (const candidate of candidates) {
			const id = opportunityId(candidate.sectionKey, candidate.kind);
			// A best-fit slot's section is never a detection target (the slot
			// may resolve to any kind), so an opportunity there — confirmed
			// or pinned — would stack a second visual beside the slot's.
			if (
				kept.length >= GLOSSY_MAX_OPPORTUNITIES ||
				!keys.has(candidate.sectionKey) ||
				bestFitSections.has(candidate.sectionKey) ||
				reserved.get(candidate.sectionKey)?.has(candidate.kind) ||
				seen.has(id)
			) {
				continue;
			}
			seen.add(id);
			kept.push({
				sectionKey: candidate.sectionKey,
				kind: candidate.kind,
			});
		}
		return kept;
	};

	if (options.mode === "align_first") {
		return {
			slots,
			opportunities: keep(options.confirmedOpportunities),
			detection: null,
		};
	}

	const pinned = prior ? keep(prior.opportunities) : [];
	const limit = GLOSSY_MAX_OPPORTUNITIES - pinned.length;
	const changed = sections
		.map((entry) => entry.key)
		.filter(
			(key) =>
				!(prior?.sectionKeys.has(key) ?? false) &&
				!bestFitSections.has(key),
		);
	return {
		slots,
		opportunities: pinned,
		detection:
			changed.length > 0 && limit > 0
				? { sectionKeys: changed, limit }
				: null,
	};
}
