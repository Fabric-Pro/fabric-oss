import {
	isProposalClientDocument,
	listProposalVisualSpecSummaries,
	sanitizeContent,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	buildFindingEchoCarried,
	buildSettledDecisionsBlock,
} from "@repo/temporal/proposal-artifact-settled-decisions";
import {
	checkPreservation,
	type PreservationScope,
	type PreservationViolation,
} from "@repo/utils/proposal-artifact/preservation";
import {
	type CarriedSettledText,
	checkResponseEcho,
	echoedStableKeys,
} from "@repo/utils/proposal-artifact/response-echo";
import { SCOPED_REVISION_REFUSAL } from "@repo/utils/proposal-artifact/scoped-revision-codes";
import {
	buildSectionMap,
	findSection,
} from "@repo/utils/proposal-artifact/section-hash";

/**
 * The server checks of an AI writer's change to a client-document Proposal's
 * Main (Fizzy #2946), run on the body as it would be saved:
 *
 *  - structure (`checkPreservation`): the change kept everything outside its
 *    target, and every existing diagram;
 *  - echo (`checkResponseEcho`): Main repeats no wording of the settled
 *    answers and finding titles the writer's settled-decisions block
 *    carried (and, for a finding-driven revision, of that finding). A writer
 *    with no block, a project guest included, was carried nothing internal,
 *    so only the structure is checked for them.
 *
 * Every AI writer is held to them: the editor's accept of a chat proposal or
 * a finding-driven revision (`document-ai-review.ts`), and the writers that
 * replace the whole body from outside the document page, the MCP tool
 * `fabric_update_document` and the v1 `PATCH /documents/:id`, which agents
 * holding Fabric's portal tools call as well.
 *
 * No `ORPCError` and no oRPC procedure here, so the MCP gateway and the v1
 * routes can load it. Verdicts and logs carry codes, section keys and visual
 * ids, never text.
 */

type StructureRefusalCode =
	| typeof SCOPED_REVISION_REFUSAL.CHANGED_DIAGRAM
	| typeof SCOPED_REVISION_REFUSAL.OUTSIDE_TARGET;

type ClientProposalMainVerdict =
	| { ok: true }
	| {
			ok: false;
			code: StructureRefusalCode;
			/** What the change did not keep: keys, ordinals and ids only. */
			violations: PreservationViolation[];
	  }
	| {
			ok: false;
			code: typeof SCOPED_REVISION_REFUSAL.RESPONSE_ECHOED;
			/** The stable keys of the repeated answers, for logs only. */
			stableKeys: string[];
	  };

/** The finding a revision applied, as its echo check reads it. */
interface AppliedFinding {
	stableKey: string;
	title: string;
	recommendation: string | null;
	/** The finding's current answer text; null when it has none. */
	responseText: string | null;
}

/**
 * Check a change of a client-document Proposal's Main. The caller has
 * decided the document is one, and normalized `next` to what the save will
 * store.
 */
export async function checkClientProposalMain(args: {
	projectId: string;
	documentId: string;
	/** The project's owning organization. */
	owningOrganizationId: string;
	/** The writer: the settled answers they were carried are checked. */
	userId: string;
	/** Main as stored, at the base the write is guarded by. */
	previous: string;
	/** Main as the save will store it. */
	next: string;
	scope: PreservationScope;
	/** For a finding-driven revision: the finding it applied. */
	finding?: AppliedFinding | null;
}): Promise<ClientProposalMainVerdict> {
	const preservationInput = {
		previous: args.previous,
		next: args.next,
		scope: args.scope,
	};
	const preservation = checkPreservation(preservationInput);
	if (!preservation.ok) {
		const changedDiagram = preservation.violations.some(
			(violation) =>
				violation.code === SCOPED_REVISION_REFUSAL.CHANGED_DIAGRAM,
		);
		let violations = preservation.violations;
		if (changedDiagram) {
			// The stored specs only classify a changed diagram, so they are
			// read only when there is one, and the check runs again with them.
			const classified = checkPreservation({
				...preservationInput,
				visualSpecs: await listProposalVisualSpecSummaries({
					organizationId: args.owningOrganizationId,
					projectId: args.projectId,
					documentId: args.documentId,
				}),
			});
			if (!classified.ok) {
				violations = classified.violations;
			}
		}
		return {
			ok: false,
			code: changedDiagram
				? SCOPED_REVISION_REFUSAL.CHANGED_DIAGRAM
				: SCOPED_REVISION_REFUSAL.OUTSIDE_TARGET,
			violations,
		};
	}

	// Internal answers, and for a revision the finding it applied (its
	// answer, title and recommendation, as the revision checked them), must
	// not be quoted into a body every reader sees. A guest has no block:
	// nothing internal was carried for them.
	const block = await buildSettledDecisionsBlock({
		projectId: args.projectId,
		documentId: args.documentId,
		starterUserId: args.userId,
		organizationId: args.owningOrganizationId,
	});
	const finding = args.finding ?? null;
	const carried: CarriedSettledText = finding
		? buildFindingEchoCarried({
				settled: block,
				finding,
				response: { text: finding.responseText },
			})
		: (block?.carried ?? { responseTexts: [], findingTitles: [] });
	const echo = checkResponseEcho({
		mainText: args.next,
		carried,
		previousMain: args.previous,
	});
	if (echo.echoed) {
		return {
			ok: false,
			code: SCOPED_REVISION_REFUSAL.RESPONSE_ECHOED,
			stableKeys: echoedStableKeys(carried, echo),
		};
	}
	return { ok: true };
}

/**
 * Check an AI writer that replaces a client-document Proposal's whole Main
 * from outside the document page: the MCP tool `fabric_update_document` or
 * the v1 `PATCH /documents/:id`. Any other document, a Proposal whose owning
 * organization has the gate off, or a project outside any organization
 * passes unchecked.
 *
 * Such a writer declares no target and no person reviews its diff, so it is
 * checked with the `whole-body` scope: prose may change anywhere, a diagram
 * may move or be added, and every existing diagram must still be there
 * unchanged, even when its section was removed or renamed (a chat accept
 * may drop a removed section's diagrams, since a person reviewed that diff);
 * and the body may not repeat a settled answer of `userId` (the MCP
 * session's user, or the API key's creator) in the owning organization, as
 * a chat accept may not. A caller with no settled block (a project guest, or
 * a member with nothing settled) gets the diagram check alone.
 *
 * `next` is the body the path is about to write, after its own
 * normalization; `previous` the stored body its write is guarded by.
 */
export async function checkWholeBodyAiWrite(args: {
	/** The write path, for the log line. */
	surface: "mcp" | "v1";
	projectId: string;
	documentId: string;
	documentType: string;
	/** The project's owning organization, never the caller's. */
	owningOrganizationId: string | null;
	userId: string;
	previous: string;
	next: string;
}): Promise<ClientProposalMainVerdict> {
	const owningOrganizationId = args.owningOrganizationId;
	if (
		!owningOrganizationId ||
		!(await isProposalClientDocument({
			organizationId: owningOrganizationId,
			documentType: args.documentType,
		}))
	) {
		return { ok: true };
	}

	const verdict = await checkClientProposalMain({
		projectId: args.projectId,
		documentId: args.documentId,
		owningOrganizationId,
		userId: args.userId,
		previous: args.previous,
		// What the write stores: the query layer strips null bytes.
		next: sanitizeContent(args.next),
		scope: { kind: "whole-body" },
	});
	if (!verdict.ok) {
		logger.info(
			{
				documentId: args.documentId,
				projectId: args.projectId,
				organizationId: owningOrganizationId,
				surface: args.surface,
				code: verdict.code,
				...("violations" in verdict
					? { violations: verdict.violations }
					: { stableKeys: verdict.stableKeys }),
			},
			"[client-proposal-main-check] whole-body AI write refused",
		);
	}
	return verdict;
}

/** A refused diagram, named for the writer that sent the change. */
interface RefusedDiagram {
	/** 1-based position among the diagrams of the body the writer read. */
	diagram: number;
	/** Its section's heading in that body; null above the first heading. */
	section: string | null;
	/** The diagram's visual id, when it carried a marker. */
	visualId?: string;
}

/** How many refused diagrams a refusal message names. */
const NAMED_DIAGRAMS_MAX = 5;

/**
 * The diagrams a structure refusal names, read off the previous body. Its
 * headings are the document's own text, which the writer read.
 */
export function refusedDiagrams(
	previous: string,
	violations: readonly PreservationViolation[],
): RefusedDiagram[] {
	const sections = buildSectionMap(previous);
	const diagrams: RefusedDiagram[] = [];
	for (const violation of violations) {
		if (
			violation.code !== SCOPED_REVISION_REFUSAL.CHANGED_DIAGRAM ||
			violation.ordinal === undefined
		) {
			continue;
		}
		const section = violation.sectionKey
			? findSection(sections, violation.sectionKey)
			: undefined;
		diagrams.push({
			diagram: violation.ordinal + 1,
			section: section?.headingText ?? null,
			...(violation.visualId ? { visualId: violation.visualId } : {}),
		});
	}
	return diagrams;
}

/**
 * The refusal message of a whole-body AI write, for the MCP tool and the v1
 * route alike. It names the refused diagrams by position and heading, and
 * never any settled answer's text.
 */
export function wholeBodyRefusalMessage(
	verdict: Exclude<ClientProposalMainVerdict, { ok: true }>,
	previous: string,
): string {
	if (verdict.code === SCOPED_REVISION_REFUSAL.RESPONSE_ECHOED) {
		return "The update was not saved: it repeats wording from the Internal Analysis, which stays internal. Write the change in your own words and send it again.";
	}
	if (verdict.code === SCOPED_REVISION_REFUSAL.OUTSIDE_TARGET) {
		return "The update was not saved: it changed sections it did not target.";
	}
	const diagrams = refusedDiagrams(previous, verdict.violations);
	const named = diagrams
		.slice(0, NAMED_DIAGRAMS_MAX)
		.map(({ diagram, section }) =>
			section === null
				? `diagram ${diagram} (above the first heading)`
				: `diagram ${diagram} (under “${section}”)`,
		);
	const more = diagrams.length - named.length;
	const list =
		named.length === 0
			? "an existing diagram"
			: `${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
	return (
		`The update was not saved: it changed or removed ${list}, counting diagrams from the top of the document as you read it. ` +
		"Keep every existing diagram exactly as you read it, even when you remove or rename its section; prose may change, and a diagram may move. " +
		"A diagram changes only through its Edit with instructions in Fabric."
	);
}
