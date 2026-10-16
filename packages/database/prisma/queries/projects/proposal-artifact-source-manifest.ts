/**
 * Proposal artifact (Fizzy #2946) — the source manifest an analysis run
 * stores with its source context, and the evidence read of the sources its
 * findings cite.
 */

import { cutAtCodeUnits } from "@repo/utils/cut-at-code-units";
import { z } from "zod";
import { db, type Prisma } from "../../client";
import { sanitizeContent } from "./documents";

/**
 * What kind of retrieval string a source was: a project context row (with its
 * type), a company context source, the injected project summary, or anything
 * else (conversation bundles, supplied context, a source no row stands for).
 */
export const PROPOSAL_SOURCE_MANIFEST_KINDS = [
	"projectContext",
	"company",
	"summary",
	"other",
] as const;
export type ProposalSourceManifestKind =
	(typeof PROPOSAL_SOURCE_MANIFEST_KINDS)[number];

/** Most entries one run's manifest keeps; later entries are dropped. */
export const PROPOSAL_SOURCE_MANIFEST_MAX_ENTRIES = 200;
/** Longest title or source name an entry keeps. */
export const PROPOSAL_SOURCE_MANIFEST_LABEL_MAX_LENGTH = 300;
const MANIFEST_ID_MAX_LENGTH = 200;
const MANIFEST_CONTEXT_TYPE_MAX_LENGTH = 64;
const MANIFEST_FINGERPRINT_MAX_LENGTH = 64;
/** Postgres `integer`: the largest source number a finding may cite. */
export const MAX_SOURCE_NUMBER = 2_147_483_647;

const sourceManifestEntrySchema = z.object({
	/** The `### Source N` number the stored source context gave it. */
	source: z.number().int().min(1).max(MAX_SOURCE_NUMBER),
	kind: z.enum(PROPOSAL_SOURCE_MANIFEST_KINDS),
	/** The project context id, or the company context `sourceId`. */
	id: z.string().max(MANIFEST_ID_MAX_LENGTH).nullable(),
	/** The project context type, for `projectContext`. */
	contextType: z.string().max(MANIFEST_CONTEXT_TYPE_MAX_LENGTH).nullable(),
	title: z.string().max(PROPOSAL_SOURCE_MANIFEST_LABEL_MAX_LENGTH).nullable(),
	/** The company context source's name, for `company`. */
	sourceName: z
		.string()
		.max(PROPOSAL_SOURCE_MANIFEST_LABEL_MAX_LENGTH)
		.nullable(),
	/** A fingerprint of the retrieval string, to check alignment by. */
	fingerprint: z.string().min(1).max(MANIFEST_FINGERPRINT_MAX_LENGTH),
	// No source text is kept (Fizzy #2946): evidence reads a source's current
	// row, so text someone has since removed from it is never served again.
});

const sourceManifestSchema = z
	.array(sourceManifestEntrySchema)
	.max(PROPOSAL_SOURCE_MANIFEST_MAX_ENTRIES);

export type ProposalSourceManifestEntry = z.infer<
	typeof sourceManifestEntrySchema
>;
export type ProposalSourceManifest = ProposalSourceManifestEntry[];

/** A manifest entry as a writer builds it; optional fields default to null. */
export interface ProposalSourceManifestEntryInput {
	source: number;
	kind: ProposalSourceManifestKind;
	id?: string | null;
	contextType?: string | null;
	title?: string | null;
	sourceName?: string | null;
	fingerprint: string;
}

function cappedLabel(
	value: string | null | undefined,
	max: number,
): string | null {
	const text = value ? sanitizeContent(value) : "";
	return text ? cutAtCodeUnits(text, max) : null;
}

/**
 * Bound a manifest before it is stored: text fields are cut to their caps
 * (and stripped of the null bytes Postgres JSON refuses), entries past
 * {@link PROPOSAL_SOURCE_MANIFEST_MAX_ENTRIES} are dropped, and an entry the
 * schema still refuses (an unknown kind, a source number that is not a
 * positive integer, no fingerprint) is left out rather than failing the run.
 */
export function normalizeSourceManifest(
	entries: readonly ProposalSourceManifestEntryInput[],
): ProposalSourceManifest {
	const manifest: ProposalSourceManifest = [];
	for (const entry of entries) {
		if (manifest.length >= PROPOSAL_SOURCE_MANIFEST_MAX_ENTRIES) {
			break;
		}
		const parsed = sourceManifestEntrySchema.safeParse({
			source: entry.source,
			kind: entry.kind,
			id: cappedLabel(entry.id, MANIFEST_ID_MAX_LENGTH),
			contextType: cappedLabel(
				entry.contextType,
				MANIFEST_CONTEXT_TYPE_MAX_LENGTH,
			),
			title: cappedLabel(
				entry.title,
				PROPOSAL_SOURCE_MANIFEST_LABEL_MAX_LENGTH,
			),
			sourceName: cappedLabel(
				entry.sourceName,
				PROPOSAL_SOURCE_MANIFEST_LABEL_MAX_LENGTH,
			),
			fingerprint: entry.fingerprint,
		});
		if (parsed.success) {
			manifest.push(parsed.data);
		}
	}
	return manifest;
}

/**
 * A stored manifest, parsed. Null for a run that has none (rows written
 * before manifests existed, runs that never started) and for a value the
 * schema refuses, so an old or damaged row reads as "no evidence", never as
 * an error.
 */
export function parseStoredSourceManifest(
	value: Prisma.JsonValue | null | undefined,
): ProposalSourceManifest | null {
	if (value === null || value === undefined) {
		return null;
	}
	const parsed = sourceManifestSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

/** A bounded manifest as the JSON column takes it. */
export function toJson(
	manifest: ProposalSourceManifest,
): Prisma.InputJsonValue {
	return manifest as unknown as Prisma.InputJsonValue;
}

// ---------------------------------------------------------------------------
// Evidence sources, read now
// ---------------------------------------------------------------------------

/**
 * How many leading characters of a source's text the evidence read takes:
 * enough for a short excerpt once markup and runs of whitespace are gone.
 */
export const PROPOSAL_EVIDENCE_TEXT_HEAD_LENGTH = 2000;

/** A project context a finding cites, as its row reads now. */
export interface ProposalEvidenceContextRow {
	id: string;
	/** The context's type now. */
	type: string;
	sourceTitle: string | null;
	originalFilename: string | null;
	sourcePath: string | null;
	/**
	 * The opening of the row's current content, at most
	 * {@link PROPOSAL_EVIDENCE_TEXT_HEAD_LENGTH} characters.
	 */
	contentHead: string | null;
}

/** A company context source a finding cites, as its row reads now. */
export interface ProposalEvidenceCompanySourceRow {
	id: string;
	sourceTitle: string | null;
	originalFilename: string | null;
	/** As on {@link ProposalEvidenceContextRow}. */
	contentHead: string | null;
}

/**
 * The rows a Proposal analysis run's evidence names, as they read now
 * (Fizzy #2946): the project contexts still in `projectId` and the owning
 * organization, and the company context sources still the owning
 * organization's and not being deleted. An id that matches nothing is simply
 * absent.
 *
 * Read now rather than copied with the run, so text someone removed from a
 * source, or a source they deleted, is never served again. Only the opening
 * of each row's text is read — `content` can be megabytes and the evidence
 * shows a short excerpt — and no source address is selected.
 *
 * @param input.organizationId the project's owning organization, resolved
 *   from the project row by the caller.
 */
export async function readProposalEvidenceSources(input: {
	organizationId: string;
	projectId: string;
	contextIds: readonly string[];
	companySourceIds: readonly string[];
}): Promise<{
	contexts: ProposalEvidenceContextRow[];
	companySources: ProposalEvidenceCompanySourceRow[];
}> {
	const contextIds = [...new Set(input.contextIds)];
	const companySourceIds = [...new Set(input.companySourceIds)];
	const [contexts, companySources] = await Promise.all([
		contextIds.length === 0
			? []
			: db.$queryRaw<ProposalEvidenceContextRow[]>`
					SELECT c."id",
						c."type"::text AS "type",
						c."sourceTitle",
						c."originalFilename",
						c."sourcePath",
						left(c."content", ${PROPOSAL_EVIDENCE_TEXT_HEAD_LENGTH}) AS "contentHead"
					FROM "project_context" c
					WHERE c."id" = ANY(${contextIds}::text[])
						AND c."projectId" = ${input.projectId}
						AND c."organizationId" = ${input.organizationId}
				`,
		companySourceIds.length === 0
			? []
			: db.$queryRaw<ProposalEvidenceCompanySourceRow[]>`
					SELECT s."id",
						s."sourceTitle",
						s."originalFilename",
						left(s."content", ${PROPOSAL_EVIDENCE_TEXT_HEAD_LENGTH}) AS "contentHead"
					FROM "company_context_source" s
					WHERE s."id" = ANY(${companySourceIds}::text[])
						AND s."organizationId" = ${input.organizationId}
						AND s."deletingAt" IS NULL
				`,
	]);
	return { contexts, companySources };
}
