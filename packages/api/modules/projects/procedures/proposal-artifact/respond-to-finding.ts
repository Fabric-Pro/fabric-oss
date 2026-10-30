import { ORPCError } from "@orpc/client";
import {
	FindingResponseValidationError,
	getAnalysisForCurrentContent,
	normalizeFindingResponseText,
	PROPOSAL_FINDING_RESPONSE_TEXT_MAX_LENGTH,
	ProposalArtifactTenantError,
	upsertFindingResponse,
} from "@repo/database";
import {
	buildSectionMap,
	DOCUMENT_SECTION_KEY,
	documentProseHash,
	findSection,
	type SectionMap,
} from "@repo/utils/proposal-artifact/section-hash";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	loadProposalArtifactDocument,
	loadProposalFinding,
	type ProposalFindingTarget,
} from "../../lib/proposal-artifact-access";
import { requireProposalArtifactEnabled } from "../../lib/proposal-artifact-feature";
import { presentSavedAnswer, savedAnswerSchema } from "./get-analysis";

/** The refusal code for a finding written before stable keys existed. */
export const FINDING_NOT_KEYED_CODE = "FINDING_NOT_KEYED";

/**
 * The refusal code for a submit naming only one of `version` and
 * `responseId`: together they name the answer the member saw, so one alone
 * names none.
 */
export const VERSION_AND_RESPONSE_ID_TOGETHER_CODE =
	"VERSION_AND_RESPONSE_ID_TOGETHER";

/**
 * Why a submit was not saved:
 *  - `RUN_CHANGED`: the finding's run is no longer the one the tab shows, and
 *    the answer could not be carried to the shown run by its stable key;
 *  - `VERSION_CHANGED`: someone saved or cleared an answer for the key since
 *    the member last saw it.
 */
const FINDING_RESPONSE_STALE_REASONS = [
	"RUN_CHANGED",
	"VERSION_CHANGED",
] as const;

/**
 * The kinds a member may give, spelled out here rather than taken from the
 * stored enum: a kind added to storage later (an applied recommendation, for
 * one) is written by its own procedure and must never be accepted here.
 */
const ANSWER_KINDS = ["CONFIRMED", "RESPONDED"] as const;

const respondToFindingFieldsSchema = z.object({
	projectId: z.string(),
	documentId: z.string(),
	/** The run whose finding the member answered. */
	runId: z.string(),
	findingId: z.string(),
	kind: z.enum(ANSWER_KINDS),
	/**
	 * Required for RESPONDED, optional for CONFIRMED. The real limit is
	 * checked on the trimmed text, which answers BAD_REQUEST with a code; this
	 * outer bound only keeps the payload small.
	 */
	text: z
		.string()
		.max(PROPOSAL_FINDING_RESPONSE_TEXT_MAX_LENGTH * 2)
		.nullish(),
	/**
	 * The id and version of the answer the member saw, both or neither.
	 * Given, the write replaces only that row at that version, so an answer
	 * cleared and given again meanwhile — a new row, back at version 1 — is
	 * never overwritten as if it were the one they saw. Omitted when they saw
	 * none: the write only creates.
	 */
	responseId: z.string().min(1).optional(),
	version: z.number().int().positive().optional(),
});

const respondToFindingInputSchema = respondToFindingFieldsSchema.superRefine(
	(input, ctx) => {
		if (
			(input.version === undefined) !==
			(input.responseId === undefined)
		) {
			ctx.addIssue({
				code: "custom",
				path: [input.version === undefined ? "version" : "responseId"],
				message:
					"version and responseId are sent together: both to replace the answer seen, neither to give a first one",
				params: { code: VERSION_AND_RESPONSE_ID_TOGETHER_CODE },
			});
		}
	},
);

const respondToFindingOutputSchema = z.discriminatedUnion("outcome", [
	z.object({
		outcome: z.literal("written"),
		stableKey: z.string(),
		/** The run the answer was recorded against (the shown run on a carry-over). */
		answeredRunId: z.string(),
		response: savedAnswerSchema,
	}),
	z.object({
		outcome: z.literal("stale"),
		reason: z.enum(FINDING_RESPONSE_STALE_REASONS),
		/**
		 * For VERSION_CHANGED, the answer saved meanwhile, or null when it was
		 * cleared; always null for RUN_CHANGED.
		 */
		current: savedAnswerSchema.nullable(),
	}),
]);

/**
 * The section an answer is given against and that section's prose hash in
 * the current content. A finding that names no section answers against the
 * whole document. When the section is gone from the current content the
 * hash the finding was raised against is kept, so the answer reads as
 * "section not found" until the section returns unchanged.
 */
function currentSection(
	finding: ProposalFindingTarget["finding"],
	sectionMap: SectionMap,
): { sectionKey: string; sectionHash: string } | null {
	if (
		finding.sectionKey === null ||
		finding.sectionKey === DOCUMENT_SECTION_KEY
	) {
		return {
			sectionKey: DOCUMENT_SECTION_KEY,
			sectionHash: sectionMap.documentProseHash,
		};
	}
	const sectionHash =
		findSection(sectionMap, finding.sectionKey)?.proseHash ??
		finding.sectionHash;
	return sectionHash ? { sectionKey: finding.sectionKey, sectionHash } : null;
}

/** A run's lineage root: a re-run belongs to the run whose sources it read. */
function lineageRoot(run: { id: string; sourceRunId: string | null }): string {
	return run.sourceRunId ?? run.id;
}

function notKeyed(): ORPCError<"PRECONDITION_FAILED", unknown> {
	return new ORPCError("PRECONDITION_FAILED", {
		message: "Re-run the analysis to answer this finding.",
		data: { code: FINDING_NOT_KEYED_CODE },
	});
}

/** A malformed answer, refused with the validation's code. */
function invalidAnswer(
	error: FindingResponseValidationError,
): ORPCError<"BAD_REQUEST", unknown> {
	return new ORPCError("BAD_REQUEST", {
		message: "The answer is not valid",
		data: { code: error.code },
	});
}

/**
 * Confirm or answer a finding of a Proposal's Internal Analysis (Fizzy
 * #2946). The answer belongs to the document and the finding's stable key,
 * not to the run, and records the current prose hash of the finding's
 * section, so a later edit of that section shows it as Needs Review.
 *
 * The finding must be one of the named run's, and the run one of the
 * document's (NOT_FOUND otherwise). When the named run is not the one the tab
 * now shows, the answer carries over by stable key only when both runs
 * analyzed the same prose and share a lineage (a re-run maps to the
 * generation whose sources it read and to that generation's other re-runs,
 * never across a regeneration) and the shown run raises the key; it is then
 * recorded against the shown run and its finding's title. Otherwise the
 * submit answers `stale` with `RUN_CHANGED`, and the member's draft stays
 * with them.
 *
 * A lost race answers `stale` with `VERSION_CHANGED` and the answer saved
 * meanwhile: the write names the answer the member saw by id and version
 * together, so one cleared and given again since is a change too. A stale submit is an answer, not an error: an error would copy
 * the input — the member's text — into the error audit trail.
 *
 * The author is the session user; nothing in the input names one. The audit
 * row carries the key, kind, version and run ids, never the answer's text or
 * the finding's title.
 *
 * AUTHORIZATION: `requireProposalArtifactEnabled` first (gate off → NOT_FOUND
 * for every caller), then `requireProjectPermission(DOCUMENT_UPDATE)`, then
 * `loadProposalArtifactDocument` (document in project, project access, edit
 * access, membership of the owning organization, a Proposal).
 */
export const respondToFindingProcedure = tenantProtectedProcedure
	.use(requireProposalArtifactEnabled())
	.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/documents/{documentId}/proposal-artifact/analysis/responses",
		tags: ["Projects", "Proposal artifact"],
		summary: "Answer an analysis finding",
		description:
			"Confirms or answers a finding of a Proposal's Internal Analysis. Answers a stale outcome, with nothing saved, when the analysis or the saved answer changed meanwhile. Organization members with edit access only.",
	})
	.input(respondToFindingInputSchema)
	.output(respondToFindingOutputSchema)
	.handler(async ({ input, context }) => {
		const { document, organizationId } = await loadProposalArtifactDocument(
			{
				projectId: input.projectId,
				documentId: input.documentId,
				userId: context.user.id,
				write: true,
			},
		);

		// Refuse a malformed answer before anything about the analysis is read.
		try {
			normalizeFindingResponseText(input.kind, input.text);
		} catch (error) {
			if (error instanceof FindingResponseValidationError) {
				throw invalidAnswer(error);
			}
			throw error;
		}

		const { run, finding } = await loadProposalFinding({
			organizationId,
			documentId: document.id,
			runId: input.runId,
			findingId: input.findingId,
		});
		const stableKey = finding.stableKey;
		if (stableKey === null) {
			throw notKeyed();
		}

		const sectionMap = buildSectionMap(document.content);
		const { run: shown } = await getAnalysisForCurrentContent({
			organizationId,
			documentId: document.id,
			currentProseHash: sectionMap.documentProseHash,
			computeProseHash: documentProseHash,
		});

		let answeredRunId = run.id;
		let findingTitle = finding.title;
		let target: ProposalFindingTarget["finding"] = finding;
		if (!shown || shown.id !== run.id) {
			const carried =
				shown &&
				run.proseHash !== null &&
				run.proseHash === shown.proseHash &&
				lineageRoot(run) === lineageRoot(shown)
					? shown.findings.find(
							(candidate) => candidate.stableKey === stableKey,
						)
					: undefined;
			if (!shown || !carried) {
				return {
					outcome: "stale" as const,
					reason: "RUN_CHANGED" as const,
					current: null,
				};
			}
			answeredRunId = shown.id;
			findingTitle = carried.title;
			target = {
				id: carried.id,
				title: carried.title,
				recommendation: carried.recommendation,
				stableKey,
				sectionKey: carried.sectionKey,
				sectionHash: carried.sectionHash,
			};
		}

		const section = currentSection(target, sectionMap);
		if (!section) {
			throw notKeyed();
		}

		// The answer the member saw; the input schema admits both or neither.
		// Neither only creates, so nothing they did not see is overwritten.
		const seen =
			input.responseId === undefined || input.version === undefined
				? {}
				: {
						expectedResponseId: input.responseId,
						expectedVersion: input.version,
					};

		let result: Awaited<ReturnType<typeof upsertFindingResponse>>;
		try {
			result = await upsertFindingResponse({
				organizationId,
				projectId: input.projectId,
				documentId: document.id,
				stableKey,
				kind: input.kind,
				text: input.text,
				findingTitle,
				answeredRunId,
				sectionKey: section.sectionKey,
				sectionHash: section.sectionHash,
				authorId: context.user.id,
				...seen,
			});
		} catch (error) {
			if (error instanceof FindingResponseValidationError) {
				throw invalidAnswer(error);
			}
			if (error instanceof ProposalArtifactTenantError) {
				// The reads above saw the same rows; reaching this means the
				// document or the run went away in between.
				throw new ORPCError("NOT_FOUND", {
					message: "Document not found",
				});
			}
			throw error;
		}

		if (result.outcome === "stale") {
			return {
				outcome: "stale" as const,
				reason: "VERSION_CHANGED" as const,
				current: result.current
					? await presentSavedAnswer(result.current)
					: null,
			};
		}

		const { response } = result;
		recordAuditFromRequest(context, {
			action: "project.document_analysis.responded",
			category: "project",
			outcome: "success",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "project_document",
				id: document.id,
				name: null,
			},
			metadata: {
				stableKey: response.stableKey,
				kind: response.kind,
				version: response.version,
				answeredRunId,
				requestedRunId: input.runId,
				carriedOver: answeredRunId !== input.runId,
			},
		});

		return {
			outcome: "written" as const,
			stableKey: response.stableKey,
			answeredRunId,
			response: await presentSavedAnswer(response),
		};
	});
