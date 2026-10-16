import {
	db,
	type ProposalSourceManifest,
	readProposalEvidenceSources,
} from "@repo/database";
import { cutAtCodeUnits } from "@repo/utils/cut-at-code-units";
import { parseMarkdownAst } from "@repo/utils/proposal-artifact/markdown-ast";
import { z } from "zod";

/**
 * The evidence a Proposal analysis finding cites (Fizzy #2946), resolved at
 * read time against the rows as they are now.
 *
 * A finding names sources by their `### Source N` number; the run's source
 * manifest says what each number was when the run read it. The manifest is a
 * record of the past, so nothing it says about a row's text is shown:
 *
 *  - a project context resolves only while its row is still in THIS project
 *    and the owning organization, and shows the row's current title and an
 *    excerpt of its current text. A LINK or MEETING_TRANSCRIPT context (by
 *    its type now) also opens at its in-app page;
 *  - a company context source resolves only while it is still the owning
 *    organization's and not being deleted, and shows its current title and
 *    an excerpt of its current text;
 *  - the project summary and anything else retrieval read (conversation
 *    bundles, supplied context) have no row to read now, so they show the
 *    label stored with the run and no text at all;
 *  - a source that no longer resolves — deleted, moved to another project or
 *    organization, or a number the manifest does not hold — is "removed", and
 *    says nothing else.
 *
 * A run with no manifest at all (one recorded before manifests existed, or a
 * re-run whose source run has none) shows no evidence: with nothing to check
 * a cited number against, no source is called removed, and nothing is read.
 *
 * So text someone removes from a source stops showing on the next read, even
 * though the row keeps its id. A link is only ever an in-app route built here
 * from ids; a URL stored with a source (a LINK context's address) is never
 * read or returned.
 */

/** Context types whose in-app page a source links to. */
const LINKED_CONTEXT_TYPES = new Set(["LINK", "MEETING_TRANSCRIPT"]);

/** Longest excerpt a source shows, in UTF-16 units. */
const PROPOSAL_EVIDENCE_EXCERPT_MAX_LENGTH = 300;

/** Longest title a source shows, in UTF-16 units. */
const EVIDENCE_TITLE_MAX_LENGTH = 300;

const sourceNumber = z.number().int().positive();

/**
 * The opening of the row's current text as plain text, at most
 * {@link PROPOSAL_EVIDENCE_EXCERPT_MAX_LENGTH} characters; null when the row
 * has no text yet.
 */
const currentExcerpt = z.string().nullable();

export const proposalEvidenceSchema = z.discriminatedUnion("kind", [
	z.object({
		source: sourceNumber,
		kind: z.literal("projectContext"),
		/** The context's type, as the row has it now. */
		contextType: z.string(),
		/** The context's title now. */
		title: z.string().nullable(),
		excerpt: currentExcerpt,
		/**
		 * The context's in-app page, for LINK and MEETING_TRANSCRIPT contexts;
		 * null for every other type.
		 */
		link: z
			.object({
				contextId: z.string(),
				href: z.string().startsWith("/app/"),
			})
			.nullable(),
	}),
	z.object({
		source: sourceNumber,
		kind: z.literal("company"),
		/** The company context source's title now. */
		title: z.string().nullable(),
		excerpt: currentExcerpt,
	}),
	z.object({
		source: sourceNumber,
		/** The project summary the run was given: its stored label only. */
		kind: z.literal("summary"),
		title: z.string().nullable(),
	}),
	z.object({
		source: sourceNumber,
		/**
		 * Material with no row behind it, such as a conversation bundle: its
		 * stored label only.
		 */
		kind: z.literal("other"),
		title: z.string().nullable(),
	}),
	z.object({
		source: sourceNumber,
		/** The source no longer resolves; nothing else about it is shown. */
		kind: z.literal("removed"),
	}),
]);

type ProposalEvidence = z.infer<typeof proposalEvidenceSchema>;

/** Resolves the source numbers of one finding to its evidence entries. */
type ProposalEvidenceResolver = (
	sourceRefs: readonly number[],
) => ProposalEvidence[];

/** Control characters and every kind of whitespace, collapsed to one space. */
const WHITESPACE_AND_CONTROLS = /[\s\p{Cc}]+/gu;

function collapse(text: string): string {
	return text.replace(WHITESPACE_AND_CONTROLS, " ").trim();
}

/** Markdown nodes that run on within a line; every other node is a block. */
const INLINE_NODE_TYPES = new Set([
	"text",
	"emphasis",
	"strong",
	"delete",
	"inlineCode",
	"link",
	"linkReference",
]);

type MarkdownNode = {
	type: string;
	value?: unknown;
	children?: readonly MarkdownNode[];
};

/**
 * The words a reader sees in a Markdown tree: literal text and code, without
 * markup, link targets or raw HTML. Blocks are kept apart by a space.
 */
function collectText(node: MarkdownNode, out: string[]): void {
	if (node.type === "html") {
		return;
	}
	if (typeof node.value === "string") {
		out.push(node.value);
	}
	for (const child of node.children ?? []) {
		collectText(child, out);
	}
	if (!INLINE_NODE_TYPES.has(node.type)) {
		out.push(" ");
	}
}

/**
 * A source's current text as an excerpt: plain text (Markdown read as a
 * reader sees it, raw HTML dropped), whitespace collapsed, at most
 * {@link PROPOSAL_EVIDENCE_EXCERPT_MAX_LENGTH} UTF-16 units and never cut
 * inside a surrogate pair. Null when nothing readable is left.
 */
function proposalEvidenceExcerpt(
	text: string | null | undefined,
): string | null {
	if (!text) {
		return null;
	}
	const words: string[] = [];
	collectText(parseMarkdownAst(text) as MarkdownNode, words);
	const excerpt = cutAtCodeUnits(
		collapse(words.join("")),
		PROPOSAL_EVIDENCE_EXCERPT_MAX_LENGTH,
	).trimEnd();
	return excerpt || null;
}

/** The first label that says something, collapsed and capped; else null. */
function currentTitle(
	...labels: readonly (string | null | undefined)[]
): string | null {
	for (const label of labels) {
		const title = label ? collapse(label) : "";
		if (title) {
			return cutAtCodeUnits(title, EVIDENCE_TITLE_MAX_LENGTH);
		}
	}
	return null;
}

function contextHref(
	slug: string,
	projectId: string,
	contextId: string,
): string {
	return `/app/${encodeURIComponent(slug)}/projects/${encodeURIComponent(
		projectId,
	)}/contexts/${encodeURIComponent(contextId)}`;
}

/**
 * Build the resolver for one run's findings: every row the cited sources
 * name is read once, as it is now, scoped to the project and its owning
 * organization.
 *
 * @param input.organizationId the project's owning organization, resolved
 *   from the project row.
 * @param input.manifest the shown run's manifest (a re-run's is its source
 *   run's); null when it has none, which resolves every finding to no
 *   evidence at all and reads no row.
 * @param input.sourceRefs every source number any finding cites.
 */
export async function buildProposalEvidenceResolver(input: {
	organizationId: string;
	projectId: string;
	manifest: ProposalSourceManifest | null;
	sourceRefs: readonly number[];
}): Promise<ProposalEvidenceResolver> {
	if (!input.manifest) {
		return () => [];
	}
	const bySource = new Map(
		input.manifest.map((entry) => [entry.source, entry]),
	);
	const cited = [...new Set(input.sourceRefs)].flatMap((source) => {
		const entry = bySource.get(source);
		return entry ? [entry] : [];
	});

	const { contexts, companySources } = await readProposalEvidenceSources({
		organizationId: input.organizationId,
		projectId: input.projectId,
		contextIds: cited.flatMap((entry) =>
			entry.kind === "projectContext" && entry.id ? [entry.id] : [],
		),
		companySourceIds: cited.flatMap((entry) =>
			entry.kind === "company" && entry.id ? [entry.id] : [],
		),
	});

	// Each row's title and excerpt once, however many findings cite it.
	const contextById = new Map(
		contexts.map((row) => [
			row.id,
			{
				contextType: row.type,
				title: currentTitle(
					row.sourceTitle,
					row.originalFilename,
					row.sourcePath,
				),
				excerpt: proposalEvidenceExcerpt(row.contentHead),
			},
		]),
	);
	const companyById = new Map(
		companySources.map((row) => [
			row.id,
			{
				title: currentTitle(row.sourceTitle, row.originalFilename),
				excerpt: proposalEvidenceExcerpt(row.contentHead),
			},
		]),
	);

	const needsSlug = contexts.some((row) =>
		LINKED_CONTEXT_TYPES.has(row.type),
	);
	const organization = needsSlug
		? await db.organization.findUnique({
				where: { id: input.organizationId },
				select: { slug: true },
			})
		: null;
	const slug = organization?.slug ?? null;

	const resolve = (source: number): ProposalEvidence => {
		const entry = bySource.get(source);
		const removed = { source, kind: "removed" as const };
		if (!entry) {
			return removed;
		}
		switch (entry.kind) {
			case "projectContext": {
				const context = entry.id
					? contextById.get(entry.id)
					: undefined;
				if (!entry.id || !context) {
					return removed;
				}
				return {
					source,
					kind: "projectContext",
					contextType: context.contextType,
					title: context.title,
					excerpt: context.excerpt,
					link:
						slug && LINKED_CONTEXT_TYPES.has(context.contextType)
							? {
									contextId: entry.id,
									href: contextHref(
										slug,
										input.projectId,
										entry.id,
									),
								}
							: null,
				};
			}
			case "company": {
				const company = entry.id
					? companyById.get(entry.id)
					: undefined;
				if (!company) {
					return removed;
				}
				return {
					source,
					kind: "company",
					title: company.title,
					excerpt: company.excerpt,
				};
			}
			case "summary":
			case "other":
				return { source, kind: entry.kind, title: entry.title };
			default:
				return removed;
		}
	};

	return (sourceRefs) => [...new Set(sourceRefs)].map(resolve);
}
