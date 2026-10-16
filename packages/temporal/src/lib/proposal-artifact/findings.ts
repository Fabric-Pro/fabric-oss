/**
 * The Internal Analysis's findings as stored (Fizzy #2801, #2946): the
 * model's answer turned into bounded rows, each with a stable key (type,
 * section, subject), its section's key and prose hash, and the `### Source N`
 * numbers it cites that the run's source context emitted. Same-key findings
 * fold into one per run.
 *
 * Pure: no I/O, and the database import is type-only. Activity code only
 * (it hashes with `node:crypto`); workflow code must not import it.
 */

import { createHash } from "node:crypto";
import { truncateCodePoints } from "@repo/agent-prompts/glossy";
import type {
	AnalysisFindingInput,
	ProposalSourceManifest,
	ProposalFindingSeverity as StoredFindingSeverity,
	ProposalFindingType as StoredFindingType,
} from "@repo/database";
import {
	DOCUMENT_SECTION_KEY,
	type ProseSection,
	type SectionMap,
} from "@repo/utils/proposal-artifact/section-hash";
import {
	PROPOSAL_FINDING_SEVERITIES,
	type ProposalFindingSeverity,
	type ProposalFindingType,
} from "./types";

/** Findings kept from one review, in the model's order. */
export const MAX_FINDINGS = 50;

export const FINDING_TITLE_MAX_CHARS = 200;
export const FINDING_DETAIL_MAX_CHARS = 4_000;
const FINDING_RECOMMENDATION_MAX_CHARS = 2_000;
const FINDING_SECTION_HEADING_MAX_CHARS = 300;

/** The longest subject phrase that counts towards a finding's key. */
const FINDING_SUBJECT_MAX_CHARS = 200;
/** Titles of folded findings kept on the one that absorbed them. */
export const MAX_FOLDED_TITLES = 20;
/** Source refs kept per finding. */
export const MAX_SOURCE_REFS = 20;

/**
 * Version of {@link findingStableKey}. A change to what the key covers or how
 * the subject is normalised bumps it, so an older key reads as another
 * finding rather than colliding with one.
 */
const STABLE_KEY_VERSION = "k1";

const STORED_SEVERITY: Readonly<
	Record<ProposalFindingSeverity, StoredFindingSeverity>
> = {
	Blocking: "BLOCKING",
	Important: "IMPORTANT",
	Informational: "INFORMATIONAL",
};

/** Stored severities, most severe first, in the prompt's order. */
const STORED_SEVERITY_ORDER: readonly StoredFindingSeverity[] =
	PROPOSAL_FINDING_SEVERITIES.map((severity) => STORED_SEVERITY[severity]);

const STORED_TYPE: Readonly<Record<ProposalFindingType, StoredFindingType>> = {
	Scope: "SCOPE",
	Commercial: "COMMERCIAL",
	Assumption: "ASSUMPTION",
	Risk: "RISK",
	Gap: "GAP",
	"Source Validation": "SOURCE_VALIDATION",
	Architecture: "ARCHITECTURE",
	Branding: "BRANDING",
	Opportunity: "OPPORTUNITY",
};

/**
 * One finding as the model returned it: the analysis activity's output
 * schema, with severity and type as the prompt names them and every key
 * present (null for none).
 */
export interface ModelFinding {
	severity: ProposalFindingSeverity;
	type: ProposalFindingType;
	title: string;
	subject: string | null;
	detail: string;
	recommendation: string | null;
	sectionIndex: number | null;
	sectionHeading: string | null;
	sourceRefs: number[] | null;
}

/** What the stored findings are resolved against. */
export interface FindingResolution {
	sectionMap: SectionMap;
	/** The sections the model was shown, numbered from 1. */
	listedSections: readonly ProseSection[];
	/** The `### Source N` numbers a ref may name. */
	citableSources: ReadonlySet<number>;
}

/** A stored finding before folding: every key field set. */
export type KeyedFinding = AnalysisFindingInput & {
	stableKey: string;
	sourceRefs: number[];
	foldedTitles: string[];
};

/**
 * The model's findings as stored: enum values, bounded text, empty ones
 * dropped; each with its stable key, its section's key and prose hash, and
 * the refs that name an emitted source. Findings that share a key fold into
 * the earliest, keeping the most severe classification and what the others
 * add (see {@link foldByStableKey}), so a key appears at most once per run;
 * then the list is cut to {@link MAX_FINDINGS}.
 */
export function toStoredFindings(
	findings: readonly ModelFinding[],
	resolution: FindingResolution,
): { findings: KeyedFinding[]; folded: number; droppedRefs: number } {
	const keyed: KeyedFinding[] = [];
	let droppedRefs = 0;
	for (const finding of findings) {
		const title = boundText(finding.title, FINDING_TITLE_MAX_CHARS);
		const detail = boundText(finding.detail, FINDING_DETAIL_MAX_CHARS);
		if (!title || !detail) {
			continue;
		}
		const type = STORED_TYPE[finding.type];
		const section = listedSection(
			resolution.listedSections,
			finding.sectionIndex,
		);
		const sectionKey = section?.key ?? DOCUMENT_SECTION_KEY;
		const refs = citedSources(
			finding.sourceRefs,
			resolution.citableSources,
		);
		droppedRefs += (finding.sourceRefs?.length ?? 0) - refs.length;
		keyed.push({
			severity: STORED_SEVERITY[finding.severity],
			type,
			title,
			detail,
			recommendation: boundText(
				finding.recommendation,
				FINDING_RECOMMENDATION_MAX_CHARS,
			),
			sectionHeading: boundText(
				finding.sectionHeading,
				FINDING_SECTION_HEADING_MAX_CHARS,
			),
			stableKey: findingStableKey({
				type,
				sectionKey,
				// A finding the model gave no subject is keyed by its title:
				// nothing steadier names it, and keying it by type and
				// section alone would fold unrelated findings together.
				subject:
					normalizeSubject(finding.subject) ||
					normalizeSubject(title),
			}),
			sectionKey,
			sectionHash:
				section?.proseHash ?? resolution.sectionMap.documentProseHash,
			sourceRefs: refs,
			foldedTitles: [],
		});
	}
	const { kept, folded } = foldByStableKey(keyed);
	return { findings: kept.slice(0, MAX_FINDINGS), folded, droppedRefs };
}

/**
 * The listed section a finding's index names (1-based), or null for no
 * index, a fractional one, or one outside the list: the finding is then
 * about the whole document.
 */
export function listedSection(
	sections: readonly ProseSection[],
	index: number | null | undefined,
): ProseSection | null {
	if (
		typeof index !== "number" ||
		!Number.isInteger(index) ||
		index < 1 ||
		index > sections.length
	) {
		return null;
	}
	return sections[index - 1] ?? null;
}

/**
 * The numbers a run's findings may cite. A run with a manifest: exactly the
 * sources its stored context emitted. A run recorded before manifests
 * existed: the `### Source N` headers its stored context holds, within its
 * context count. Such a header can only be told from a forged one inside a
 * source's text by its number, and either way the read finds no manifest to
 * resolve the ref against, so this bounds what is stored, not what is shown.
 */
export function citableSourceNumbers(run: {
	sourceContext: string;
	sourceManifest?: ProposalSourceManifest | null;
	contextCount: number;
}): Set<number> {
	if (run.sourceManifest) {
		return new Set(run.sourceManifest.map((entry) => entry.source));
	}
	const numbers = new Set<number>();
	for (const match of run.sourceContext.matchAll(/^### Source (\d+)$/gm)) {
		const source = Number(match[1]);
		if (source >= 1 && source <= run.contextCount) {
			numbers.add(source);
		}
	}
	return numbers;
}

/** The refs that name a citable source: whole numbers, deduplicated, in order. */
export function citedSources(
	refs: readonly number[] | null | undefined,
	citable: ReadonlySet<number>,
): number[] {
	const kept = new Set<number>();
	for (const ref of refs ?? []) {
		if (Number.isInteger(ref) && citable.has(ref)) {
			kept.add(ref);
		}
	}
	return [...kept].sort((a, b) => a - b).slice(0, MAX_SOURCE_REFS);
}

/**
 * A subject phrase as it counts towards a key: compatibility-normalised,
 * lower case, punctuation and whitespace runs as one space, a leading
 * article dropped. "The Single Sign-On" and "single sign on" are one subject.
 */
export function normalizeSubject(text: string | null | undefined): string {
	if (!text) {
		return "";
	}
	return truncateCodePoints(text.normalize("NFKC"), FINDING_SUBJECT_MAX_CHARS)
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.replace(/^(?:the|a|an) /u, "");
}

/**
 * A finding's identity across runs (Fizzy #2946): what kind of issue, in
 * which section, about what. Never its wording, which drifts between runs,
 * so a later run that raises the same issue in other words gets the same
 * key and an answer given to it carries over. Versioned, and hashed so the
 * key is a fixed length whatever the subject.
 */
export function findingStableKey(input: {
	type: StoredFindingType;
	sectionKey: string;
	subject: string;
}): string {
	const digest = createHash("sha256")
		.update(`${input.type}\n${input.sectionKey}\n${input.subject}`)
		.digest("hex")
		.slice(0, 32);
	return `${STABLE_KEY_VERSION}:${digest}`;
}

/**
 * Fold findings that share a stable key into the earliest, which keeps its
 * place, type, title and section, and gains what the others add: the most
 * severe of their severities (Blocking over Important over Informational,
 * so folding never hides a blocking finding behind a milder one, Fizzy
 * #2946), their titles (when they differ), their detail and recommendation
 * text (each distinct text once, as its own paragraph after the earliest's,
 * cut at the field's cap) and the union of their refs.
 */
export function foldByStableKey(findings: readonly KeyedFinding[]): {
	kept: KeyedFinding[];
	folded: number;
} {
	const kept: KeyedFinding[] = [];
	const byKey = new Map<
		string,
		{
			keeper: KeyedFinding;
			/** Every detail and recommendation text the keeper holds. */
			details: Set<string>;
			recommendations: Set<string>;
		}
	>();
	let folded = 0;
	for (const finding of findings) {
		const fold = byKey.get(finding.stableKey);
		if (!fold) {
			const keeper = {
				...finding,
				sourceRefs: [...finding.sourceRefs],
				foldedTitles: [],
			};
			byKey.set(finding.stableKey, {
				keeper,
				details: new Set([keeper.detail]),
				recommendations: new Set(
					keeper.recommendation ? [keeper.recommendation] : [],
				),
			});
			kept.push(keeper);
			continue;
		}
		const { keeper } = fold;
		folded += 1;
		if (severityRank(finding.severity) < severityRank(keeper.severity)) {
			keeper.severity = finding.severity;
		}
		if (
			finding.title !== keeper.title &&
			!keeper.foldedTitles.includes(finding.title) &&
			keeper.foldedTitles.length < MAX_FOLDED_TITLES
		) {
			keeper.foldedTitles.push(finding.title);
		}
		keeper.detail =
			foldedText(
				keeper.detail,
				finding.detail,
				fold.details,
				FINDING_DETAIL_MAX_CHARS,
			) ?? keeper.detail;
		keeper.recommendation = foldedText(
			keeper.recommendation ?? null,
			finding.recommendation ?? null,
			fold.recommendations,
			FINDING_RECOMMENDATION_MAX_CHARS,
		);
		keeper.sourceRefs = [
			...new Set([...keeper.sourceRefs, ...finding.sourceRefs]),
		]
			.sort((a, b) => a - b)
			.slice(0, MAX_SOURCE_REFS);
	}
	return { kept, folded };
}

/**
 * Where a stored severity stands, 0 for the most severe. One the order does
 * not name ranks below every known severity, so it never displaces one.
 */
function severityRank(severity: StoredFindingSeverity): number {
	const rank = STORED_SEVERITY_ORDER.indexOf(severity);
	return rank === -1 ? STORED_SEVERITY_ORDER.length : rank;
}

/**
 * `text` with `addition` after it as its own paragraph, cut at `maxChars`;
 * `text` unchanged when `addition` is empty or one of the texts it already
 * holds (`seen`, which gains `addition`).
 */
export function foldedText(
	text: string | null,
	addition: string | null,
	seen: Set<string>,
	maxChars: number,
): string | null {
	if (!addition || seen.has(addition)) {
		return text;
	}
	seen.add(addition);
	return text ? boundText(`${text}\n\n${addition}`, maxChars) : addition;
}

/**
 * Trimmed and capped at `maxChars` code points, an ellipsis marking a cut;
 * null when nothing is left.
 */
export function boundText(
	value: string | null | undefined,
	maxChars: number,
): string | null {
	const text = value?.trim();
	return text ? truncateCodePoints(text, maxChars) : null;
}
