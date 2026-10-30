import { randomUUID } from "node:crypto";
import {
	boundGlossyField,
	GLOSSY_MAX_OPPORTUNITIES,
	GLOSSY_STYLE_DIRECTION_MAX_CHARS,
	type GlossyDetectableKind,
} from "@repo/agent-prompts/glossy";
import {
	appendProposalVisualSpec,
	db,
	resolveProposalThemeTokens,
} from "@repo/database";
import { violationCode } from "@repo/utils/glossy/fact-guard";
import { parseOutline, scanFences } from "@repo/utils/glossy/outline";
import type { VisualSpec } from "@repo/utils/glossy/visual-spec";
import {
	proposalFigureKind,
	proposalVisualTemplateOptions,
	visualSpecToMermaid,
} from "@repo/utils/glossy/visual-templates";
import { withFigureKind } from "@repo/utils/proposal-artifact/proposal-figures";
import { mintVisualId } from "@repo/utils/proposal-artifact/visual-id-server";
import {
	VISUAL_ORIGIN,
	visualSourceHash,
} from "@repo/utils/proposal-artifact/visual-identity";
import {
	comparisonToMarkdownTable,
	insertVisuals,
	type SectionVisual,
	toMermaidFence,
	toMermaidFenceBody,
} from "@repo/utils/proposal-artifact/visual-insert";
import { CancelledFailure } from "@temporalio/common";
import { detectGlossyOpportunities } from "../../lib/glossy/detect-opportunities";
import { extractGlossyVisual } from "../../lib/glossy/extract-visual";
import type { GlossyModelContext } from "../../lib/glossy/model";
import type {
	GenerateProposalVisualsInput,
	GenerateProposalVisualsResult,
} from "../../lib/proposal-artifact/types";
import {
	currentCancellationSignal,
	hasGlossyBodyText,
} from "../glossy-edition/shared";
import {
	currentActivityAttemptDeadline,
	withHeartbeatTicker,
} from "../lib/activity-liveness";
import { activityLogger } from "../lib/activity-logger";

/**
 * Visuals for a coordinated Proposal's Main document (Fizzy #2801).
 *
 * Runs between generation and the final save, so the visuals land in the
 * saved Main itself. Built from Glossy's flag-free library calls, not its
 * build activities (those are bound to `GlossyBuild` rows): one detection
 * over the Main sections, then one extraction per detected opportunity, each
 * fact-checked against its section by `extractGlossyVisual`. Timeline, flow
 * and org chart become ```` ```mermaid ```` fences; comparison becomes a
 * markdown table; stat is not produced in this release, so detection is
 * told every section already shows one.
 *
 * A fence holds no colour (Fizzy #2946): every node carries the `surface`
 * role class, and the live page and the export paint the roles from the
 * document's theme when they draw it, so a Style or Brand kit change
 * recolours a diagram without touching Main. Labels are kept short and a
 * long timeline runs top-down, so a diagram reads at page width.
 *
 * Detection and extraction are told the audience: inline visuals are for
 * executive readers, and a section whose heading starts with "Appendix" or
 * "Anhang" is marked as one, where a more technical diagram fits.
 *
 * A member can turn the step off for one document in its Style; it then
 * returns the content unchanged without a model call. No Style row means on.
 *
 * Each diagram gets a minted id on a `%% fabric-visual:` marker line, its
 * fence's first, and its fact-checked spec is stored under that id and the
 * fence body's source hash before the fence goes in (Fizzy #2946), so the
 * editor can tell a generated diagram from one a person changed. A
 * comparison table has no fence to carry a marker and stores no spec. The
 * step runs once per generation, so a rerun mints new ids; storing the same
 * spec twice is a no-op.
 *
 * Fail-open: a failed extraction, or a spec that cannot be stored, drops
 * only its own visual, and any other error, or a cancelled attempt, returns
 * the content it was given, unchanged, so the run saves Main without
 * visuals. Each model call ticks a heartbeat; a
 * progress write after each step keeps the page's staleness clock moving.
 * The caller bounds the step to one attempt; the only retry is one fresh
 * extraction for a visual the fact check refused, and it goes through the
 * same fact check, spec write and placement.
 */
export async function generateProposalVisuals(
	input: GenerateProposalVisualsInput,
): Promise<GenerateProposalVisualsResult> {
	const unchanged: GenerateProposalVisualsResult = {
		content: input.content,
		insertedCount: 0,
	};
	const ids = {
		projectId: input.projectId,
		documentId: input.documentId,
		liveRunId: input.liveRunId,
	};

	try {
		const sections = proposalVisualSections(input.content);
		if (sections.length === 0) {
			return unchanged;
		}

		await reportVisualProgress(input, VISUALS_PROGRESS_START);
		const theme = await resolveProposalThemeTokens({
			organizationId: input.organizationId,
			projectId: input.projectId,
			documentId: input.documentId,
		});
		// Off only when the document's Style says so: no Style row reads as on.
		if (theme.autoVisuals === false) {
			activityLogger.info("Proposal visuals skipped", {
				...ids,
				reason: "disabled",
			});
			return unchanged;
		}
		const styleDirection = boundGlossyField(
			theme.styleDirection,
			GLOSSY_STYLE_DIRECTION_MAX_CHARS,
		);
		const model: GlossyModelContext = {
			userId: input.userId,
			organizationId: input.organizationId,
			projectId: input.projectId,
			featureKey: PROPOSAL_VISUALS_FEATURE_KEY,
			planEligible: input.planEligible,
			abortSignal: currentCancellationSignal(),
		};

		const detection = await withHeartbeatTicker(() =>
			detectGlossyOpportunities({
				...model,
				documentType: "PROPOSAL",
				proposalArtifact: true,
				sections: sections.map((section) => ({
					sectionKey: section.key,
					heading: section.heading,
					markdown: section.markdown,
					reservedKinds: NOT_PRODUCED_KINDS,
					...(section.appendix ? { appendix: true } : {}),
				})),
				limit: GLOSSY_MAX_OPPORTUNITIES,
			}),
		);
		if (detection.status !== "detected") {
			activityLogger.info("Proposal visuals skipped", {
				...ids,
				reason: detection.status,
			});
			return unchanged;
		}
		const bySectionKey = new Map(
			sections.map((section) => [section.key, section]),
		);
		const wanted = detection.opportunities.filter(
			(opportunity) =>
				!NOT_PRODUCED_KINDS.includes(opportunity.kind) &&
				bySectionKey.has(opportunity.sectionKey),
		);
		await reportVisualProgress(input, VISUALS_PROGRESS_DETECTED);

		const deadline = currentActivityAttemptDeadline();
		const visuals: Array<SectionVisual | null> = new Array(
			wanted.length,
		).fill(null);
		const kinds: Array<string | null> = new Array(wanted.length).fill(null);
		let done = 0;
		const dropped: Partial<Record<VisualDropReason, number>> = {};
		const drop = (reason: VisualDropReason) => {
			dropped[reason] = (dropped[reason] ?? 0) + 1;
		};
		let providerMissing = false;
		let retried = 0;
		let recoveredByRetry = 0;
		// Codes only (`presence:date`), never the fact or section text.
		const logDrop = (
			kind: string,
			result: {
				reason: string;
				violations: Array<Parameters<typeof violationCode>[0]>;
			},
			attempt: number,
		) =>
			activityLogger.info("Proposal visual dropped", {
				...ids,
				kind,
				reason: result.reason,
				violations: result.violations.map(violationCode),
				...(attempt > 1 ? { attempt } : {}),
			});
		await forEachWithConcurrency(
			wanted,
			EXTRACTION_CONCURRENCY,
			async (opportunity, index) => {
				if (providerMissing || pastDeadline(deadline)) {
					return;
				}
				const section = bySectionKey.get(opportunity.sectionKey);
				if (!section) {
					return;
				}
				const extract = (variantNonce?: string) =>
					withHeartbeatTicker(() =>
						extractGlossyVisual({
							...model,
							documentType: "PROPOSAL",
							proposalArtifact: true,
							section: {
								heading: section.heading,
								markdown: section.markdown,
							},
							kind: opportunity.kind,
							styleDirection,
							source: "detected",
							...(variantNonce ? { variantNonce } : {}),
						}),
					);
				let rendered: RenderedVisual | null = null;
				let dropReason: VisualDropReason = "notProduced";
				let attempt = 1;
				try {
					let result = await extract();
					// A fact-check refusal is retried once with a fresh variant
					// nonce: a second pass often leaves out the date, name or
					// figure the section does not state. Cost: at most one
					// extra extraction call per refused visual, and none once
					// too little of the attempt is left to start one.
					if (
						result.status === "dropped" &&
						result.reason === "factCheck" &&
						!pastDeadline(deadline) &&
						model.abortSignal?.aborted !== true
					) {
						logDrop(opportunity.kind, result, attempt);
						attempt = 2;
						retried += 1;
						result = await extract(randomUUID());
					}
					if (result.status === "aiProviderNotConfigured") {
						providerMissing = true;
						return;
					}
					if (result.status === "extracted") {
						rendered = renderProposalVisual(result.spec);
					} else {
						dropReason = result.reason;
						logDrop(opportunity.kind, result, attempt);
					}
				} catch (error) {
					// A cancelled attempt stops here: no new extraction
					// starts, and the step fails open below.
					if (isCancellation(error, model.abortSignal)) {
						throw error;
					}
					// Anything else (a provider error, a spec that does not
					// render) costs only this visual; the others still go in.
					dropReason = "error";
					activityLogger.warn(
						"Proposal visual extraction failed; dropped",
						{
							...ids,
							kind: opportunity.kind,
							...(attempt > 1 ? { attempt } : {}),
							errorName:
								error instanceof Error
									? error.name
									: typeof error,
						},
					);
				}
				if (rendered?.identity) {
					const stored = await storeVisualSpec(
						input,
						rendered.identity,
					);
					if (!stored) {
						rendered = null;
						dropReason = "specWrite";
					}
				}
				if (rendered) {
					visuals[index] = {
						headingPath: section.headingPath,
						occurrenceIndex: section.occurrenceIndex,
						markdown: rendered.markdown,
					};
					kinds[index] = rendered.kind;
					if (attempt > 1) {
						recoveredByRetry += 1;
					}
				} else {
					drop(dropReason);
				}
				done += 1;
				await reportVisualProgress(
					input,
					VISUALS_PROGRESS_DETECTED +
						Math.round(
							((VISUALS_PROGRESS_END -
								VISUALS_PROGRESS_DETECTED) *
								done) /
								wanted.length,
						),
				);
			},
		);

		const ready = visuals.flatMap((visual, index) =>
			visual ? [{ visual, kind: kinds[index] ?? "unknown" }] : [],
		);
		const placed = insertVisuals(
			input.content,
			ready.map((entry) => entry.visual),
		);
		activityLogger.info("Proposal visuals generated", {
			...ids,
			sections: sections.length,
			detected: wanted.length,
			dropped,
			retried,
			recoveredByRetry,
			inserted: placed.inserted,
			insertedKinds: placed.insertedIndexes.map(
				(index) => ready[index].kind,
			),
			skipped: placed.skipped,
			unmatched: placed.unmatched,
			providerMissing,
		});
		if (placed.inserted === 0) {
			return unchanged;
		}
		return { content: placed.markdown, insertedCount: placed.inserted };
	} catch (error) {
		activityLogger.warn(
			"Proposal visuals failed; saving Main without them",
			{
				...ids,
				errorName: error instanceof Error ? error.name : typeof error,
			},
		);
		return unchanged;
	}
}

/**
 * Why a detected visual did not reach placement: the extraction's own drop
 * reason, an extraction error, a kind this release does not render, or a
 * spec that could not be stored.
 */
type VisualDropReason =
	| "truncated"
	| "invalidSpec"
	| "kindMismatch"
	| "factCheck"
	| "error"
	| "notProduced"
	| "specWrite";

/** Usage of every visuals model call is attributed here, not to Glossy. */
const PROPOSAL_VISUALS_FEATURE_KEY = "proposal-visuals";

/**
 * Kinds this release does not produce. Detection is told every section
 * already shows them, and anything detected anyway is dropped.
 */
const NOT_PRODUCED_KINDS: readonly GlossyDetectableKind[] = ["stat"];

/** Extractions in flight at once: fast enough, and gentle on the provider. */
const EXTRACTION_CONCURRENCY = 3;

/** No extraction starts with less than this left before the attempt's deadline. */
const EXTRACTION_RESERVE_MS = 45_000;

/** Progress written while visuals run; generation reports 80 before them. */
const VISUALS_PROGRESS_START = 82;
const VISUALS_PROGRESS_DETECTED = 84;
const VISUALS_PROGRESS_END = 90;

/** An opening fence whose info string names mermaid. */
const MERMAID_OPEN = /^ {0,3}(?:`{3,}|~{3,})[ \t]*mermaid(?:[\s{]|$)/i;

interface ProposalVisualSection {
	/** Caller-local key the detection call names the section by. */
	key: string;
	/** `parseOutline`'s full anchor path, as `insertVisuals` matches it. */
	headingPath: string[];
	occurrenceIndex: number;
	/** The heading's text as written. */
	heading: string;
	/** The section's own body: up to the next heading of any level. */
	markdown: string;
	/** The heading, numbering aside, starts with "Appendix" or "Anhang". */
	appendix: boolean;
}

/**
 * A leading heading number, which is structure: "5 ", "5. ", "5.2 ", "1A) ",
 * "B. ", "IV. " (a letter or numeral needs its `.` or `)`).
 */
const HEADING_NUMBERING =
	/^(?:\d+(?:\.\d+)*[A-Za-z]?\\?[.)]?|[A-Za-z]\\?[.)]|[IVXLC]+\\?[.)])\s+/i;

/** An appendix heading, in English or German, once its numbering is gone. */
const APPENDIX_HEADING = /^(?:appendix|anhang)(?![\p{L}\p{N}])/iu;

function isAppendixHeading(heading: string): boolean {
	return APPENDIX_HEADING.test(heading.trim().replace(HEADING_NUMBERING, ""));
}

/**
 * The sections a visual may go into: every heading below a leading `#`
 * title, with its own body (subsections excluded, as `insertVisuals` places
 * a visual within a section's own content). A section without body text of
 * its own, or whose own body already holds a mermaid diagram, is left out,
 * since it would get no visual.
 */
function proposalVisualSections(content: string): ProposalVisualSection[] {
	const lines = content.split("\n");
	const fences = scanFences(lines);
	const outline = parseOutline(content);
	const sections: ProposalVisualSection[] = [];

	outline.forEach((heading, index) => {
		if (index === 0 && heading.level === 1) {
			return;
		}
		// `startLine` is 1-based, so it is also the 0-based index of the line
		// after the heading.
		const bodyStart = heading.startLine;
		const bodyEnd = (outline[index + 1]?.startLine ?? lines.length + 1) - 1;
		let hasMermaid = false;
		for (let line = bodyStart; line < bodyEnd; line++) {
			if (fences[line] === "open" && MERMAID_OPEN.test(lines[line])) {
				hasMermaid = true;
				break;
			}
		}
		const markdown = lines.slice(bodyStart, bodyEnd).join("\n").trim();
		if (hasMermaid || !hasGlossyBodyText({ markdown })) {
			return;
		}
		sections.push({
			key: `section-${index}`,
			headingPath: heading.headingPath,
			occurrenceIndex: heading.occurrenceIndex,
			heading: heading.text,
			markdown,
			appendix: isAppendixHeading(heading.text),
		});
	});
	return sections;
}

/** A diagram's identity: what its spec row is stored under. */
interface VisualIdentity {
	visualId: string;
	sourceHash: string;
	kind: string;
	spec: VisualSpec;
}

interface RenderedVisual {
	kind: string;
	markdown: string;
	/** Diagrams only; a comparison table carries no marker. */
	identity?: VisualIdentity;
}

/**
 * One extracted spec as the markdown block it becomes in Main, or null for
 * a kind this release does not produce. A diagram's fence opens with a
 * freshly minted marker id, asks for its figure template when it has one,
 * and assigns roles, never colours.
 */
function renderProposalVisual(spec: VisualSpec): RenderedVisual | null {
	switch (spec.kind) {
		case "timeline":
		case "flow":
		case "org_chart": {
			const visualId = mintVisualId();
			const source = withFigureKind(
				visualSpecToMermaid(spec, proposalVisualTemplateOptions(spec)),
				proposalFigureKind(spec),
			);
			const markdown = toMermaidFence(source, visualId);
			const body = toMermaidFenceBody(source, visualId);
			return {
				kind: spec.kind,
				markdown,
				identity: {
					visualId,
					sourceHash: visualSourceHash(body),
					kind: spec.kind,
					spec,
				},
			};
		}
		case "comparison":
			return {
				kind: spec.kind,
				markdown: comparisonToMarkdownTable(spec),
			};
		default:
			return null;
	}
}

/**
 * Store a diagram's spec (origin STEP) before its fence goes into Main.
 * Returns false when the write failed, so the caller drops that visual.
 * A row whose Main save later fails is harmless: nothing references it.
 */
async function storeVisualSpec(
	input: GenerateProposalVisualsInput,
	identity: VisualIdentity,
): Promise<boolean> {
	try {
		await appendProposalVisualSpec({
			organizationId: input.organizationId,
			projectId: input.projectId,
			documentId: input.documentId,
			visualId: identity.visualId,
			sourceHash: identity.sourceHash,
			kind: identity.kind,
			origin: VISUAL_ORIGIN.STEP,
			spec: identity.spec,
			createdById: input.userId,
		});
		return true;
	} catch (error) {
		activityLogger.warn("Proposal visual spec write failed; dropped", {
			projectId: input.projectId,
			documentId: input.documentId,
			liveRunId: input.liveRunId,
			kind: identity.kind,
			errorName: error instanceof Error ? error.name : typeof error,
		});
		return false;
	}
}

/** The activity attempt was cancelled, so no further model call should start. */
function isCancellation(
	error: unknown,
	abortSignal: AbortSignal | undefined,
): boolean {
	return abortSignal?.aborted === true || error instanceof CancelledFailure;
}

function pastDeadline(deadline: Date | undefined): boolean {
	return (
		deadline !== undefined &&
		deadline.getTime() - Date.now() < EXTRACTION_RESERVE_MS
	);
}

/**
 * Bump the document's progress, and with it `updatedAt`, while the run still
 * owns it: the page reads a GENERATING document whose `updatedAt` stops
 * moving as stalled. Guarded on the run token and on GENERATING, so a
 * superseded run never moves a newer run's clock or status. Best-effort.
 */
async function reportVisualProgress(
	input: GenerateProposalVisualsInput,
	progress: number,
): Promise<void> {
	try {
		await db.projectDocument.updateMany({
			where: {
				id: input.documentId,
				liveRunId: input.liveRunId,
				status: "GENERATING",
			},
			data: { generationProgress: progress, updatedAt: new Date() },
		});
	} catch (error) {
		activityLogger.warn("Proposal visuals progress write failed", {
			documentId: input.documentId,
			liveRunId: input.liveRunId,
			errorName: error instanceof Error ? error.name : typeof error,
		});
	}
}

/**
 * Run `fn` over `items` with at most `limit` in flight; indexes are kept.
 * The first failure stops new work, waits for the calls already in flight,
 * then throws, so nothing keeps running after the activity has returned.
 */
async function forEachWithConcurrency<T>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
	let next = 0;
	let failure: { error: unknown } | null = null;
	const worker = async () => {
		while (failure === null && next < items.length) {
			const index = next++;
			try {
				await fn(items[index], index);
			} catch (error) {
				failure ??= { error };
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, worker),
	);
	if (failure !== null) {
		throw (failure as { error: unknown }).error;
	}
}
