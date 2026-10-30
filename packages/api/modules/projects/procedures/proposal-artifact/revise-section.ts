import { ORPCError } from "@orpc/client";
import { listResponsesForDocument } from "@repo/database";
import { logger } from "@repo/logs";
import {
	findBoundProposalPrompt,
	loadBoundProposalPromptText,
	proposalPromptNotBoundMessage,
} from "@repo/temporal/proposal-artifact-prompts";
import {
	reviseProposalSection,
	spliceSectionBody,
} from "@repo/temporal/proposal-artifact-revise-section";
import {
	buildFindingEchoCarried,
	buildSettledDecisionsBlock,
} from "@repo/temporal/proposal-artifact-settled-decisions";
import { contentIdentity } from "@repo/utils/content-identity";
import { isRunGuardedDocumentType } from "@repo/utils/generation-run-guard";
import { PROPOSAL_CLIENT_REVISION_AGENT_KEY } from "@repo/utils/prompt-action-catalog";
import { checkPreservation } from "@repo/utils/proposal-artifact/preservation";
import {
	buildSectionMap,
	DOCUMENT_SECTION_KEY,
	findSection,
} from "@repo/utils/proposal-artifact/section-hash";
import { z } from "zod";
import {
	enforceAiRateLimit,
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	loadProposalArtifactDocument,
	loadProposalFinding,
} from "../../lib/proposal-artifact-access";
import { requireProposalArtifactEnabled } from "../../lib/proposal-artifact-feature";
import {
	revisionSectionFingerprint,
	signRevisionToken,
} from "../../lib/proposal-revision-token";
import { FINDING_NOT_KEYED_CODE } from "./respond-to-finding";

const LOG_PREFIX = "[proposal-artifact.reviseSection]";

const outputSchema = z.discriminatedUnion("status", [
	/**
	 * The revised section, not yet saved anywhere. `body` is the section's
	 * own lines below its heading (the heading line is fixed and not part of
	 * it): the text from the heading to the next heading of any level,
	 * diagrams and visual-slot tags kept byte for byte. The editor splices it
	 * over that range of its own copy, shows it as a proposal review, and an
	 * accept saves it from `baseVersion`/`baseContentHash` with
	 * `revisionToken`, which signs the candidate section's fingerprint (its
	 * prose, link and image destinations and diagrams).
	 */
	z.object({
		status: z.literal("CANDIDATE"),
		sectionKey: z.string(),
		body: z.string(),
		baseVersion: z.number().int(),
		baseContentHash: z.string(),
		revisionToken: z.string(),
	}),
	/** Main is no longer at the base the request named. */
	z.object({ status: z.literal("STALE") }),
	/**
	 * The finding names no section (the whole document, the preamble), or
	 * its section is not in Main any more.
	 */
	z.object({ status: z.literal("SECTION_NOT_FOUND") }),
	/** The section changed since the finding was raised against it. */
	z.object({ status: z.literal("FINDING_SECTION_CHANGED") }),
	/**
	 * The model's answer broke a structural rule (a heading, a dropped or
	 * repeated diagram placeholder, the length bound) or would change Main
	 * outside the section.
	 */
	z.object({ status: z.literal("INVALID_CANDIDATE") }),
	/** The answer repeated internal wording, twice. Names no text. */
	z.object({ status: z.literal("RESPONSE_ECHOED") }),
	z.object({ status: z.literal("AI_PROVIDER_NOT_CONFIGURED") }),
	/** Nothing is bound to "Client proposal (revision)"; says what to bind. */
	z.object({
		status: z.literal("PROPOSAL_PROMPT_NOT_BOUND"),
		message: z.string(),
	}),
	z.object({ status: z.literal("RATE_LIMITED") }),
]);

type ReviseSectionOutput = z.infer<typeof outputSchema>;

/**
 * Apply a finding's recommendation (Fizzy #2946): one finding of a Proposal's
 * Internal Analysis, its section revised through the organization's bound
 * "Client proposal (revision)" prompt and returned as a candidate.
 *
 * Nothing is written. The collaborative room holds the document while it is
 * open, so a server-side write would be a second writer; the editor reviews
 * the candidate and its accept saves it, and records the finding as Resolved
 * only with the revision token signed here.
 *
 * The revision rewrites the finding's section's own lines (heading to the
 * next heading of any level); the heading stays. The finding's
 * recommendation (its title when it has none) is the instruction, labelled
 * internal guidance; its detail, evidence and the analysis report never
 * reach the model. The member's settled decisions join the prompt. The
 * candidate is checked before it is returned: it must not repeat a carried
 * answer, the finding's title or its recommendation, and spliced into Main it
 * must change nothing outside the section and no existing diagram.
 *
 * No audit row: it is an AI request whose result a person applies through a
 * normal save, which records the Resolved answer and its audit. Logs carry
 * ids, codes and lengths only.
 *
 * AUTHORIZATION: `requireProposalArtifactEnabled` first (gate off → NOT_FOUND
 * for every caller), then `requireProjectPermission(DOCUMENT_UPDATE)`, then
 * `loadProposalArtifactDocument` with `write: true` (edit access and
 * membership of the owning organization: a project guest is FORBIDDEN, since
 * findings are internal), then the finding through `loadProposalFinding` in
 * the owning organization.
 */
export const reviseProposalSectionProcedure = tenantProtectedProcedure
	.use(requireProposalArtifactEnabled())
	.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/documents/{documentId}/proposal-artifact/findings/revise",
		tags: ["Projects", "Proposal artifact"],
		summary: "Revise a Proposal section from a finding",
		description:
			"Revise the section an analysis finding names, following its recommendation, and return the candidate. The document is not changed. Organization members with edit access only.",
	})
	.input(
		z.object({
			projectId: z.string(),
			documentId: z.string(),
			/** The run whose finding is applied. */
			runId: z.string(),
			findingId: z.string(),
			/** The version of Main the editor holds. */
			baseVersion: z.number().int().nonnegative(),
			/** The identity of that body, as `projects.documents.update` returns it. */
			baseContentHash: z.string().min(1).max(128),
		}),
	)
	.output(outputSchema)
	.handler(
		async ({
			input,
			context,
			path,
			signal,
		}): Promise<ReviseSectionOutput> => {
			const userId = context.user.id;
			const { document, organizationId } =
				await loadProposalArtifactDocument({
					projectId: input.projectId,
					documentId: input.documentId,
					userId,
					write: true,
				});
			const ids = {
				organizationId,
				projectId: input.projectId,
				documentId: document.id,
				runId: input.runId,
				findingId: input.findingId,
			};

			// A Proposal's body belongs to its generation run while the run is
			// queued or writing: a candidate drawn from it now would be spliced
			// into a body the run is about to replace.
			if (
				isRunGuardedDocumentType(document.type) &&
				(document.status === "QUEUED" ||
					document.status === "GENERATING")
			) {
				throw new ORPCError("CONFLICT", {
					message:
						"A generation run is writing this document; try again when it finishes.",
					data: { code: "DOCUMENT_GENERATION_IN_PROGRESS" },
				});
			}
			const content = document.content;
			if (
				document.version !== input.baseVersion ||
				contentIdentity(content) !== input.baseContentHash
			) {
				return { status: "STALE" };
			}

			const { finding } = await loadProposalFinding({
				organizationId,
				documentId: document.id,
				runId: input.runId,
				findingId: input.findingId,
			});
			if (finding.stableKey === null) {
				throw new ORPCError("PRECONDITION_FAILED", {
					message: "Re-run the analysis to apply this finding.",
					data: { code: FINDING_NOT_KEYED_CODE },
				});
			}
			const sectionKey = finding.sectionKey;
			// Only a section with a heading is revised: the preamble has none.
			const current =
				sectionKey === null || sectionKey === DOCUMENT_SECTION_KEY
					? undefined
					: findSection(buildSectionMap(content), sectionKey);
			if (
				sectionKey === null ||
				!current ||
				current.headingText === null
			) {
				return { status: "SECTION_NOT_FOUND" };
			}
			if (finding.sectionHash !== current.proseHash) {
				return { status: "FINDING_SECTION_CHANGED" };
			}

			const prompt = await findBoundProposalPrompt({
				userId,
				organizationId,
				projectId: input.projectId,
				action: PROPOSAL_CLIENT_REVISION_AGENT_KEY,
			});
			if (!prompt) {
				return {
					status: "PROPOSAL_PROMPT_NOT_BOUND",
					message: proposalPromptNotBoundMessage(
						PROPOSAL_CLIENT_REVISION_AGENT_KEY,
					),
				};
			}

			try {
				await enforceAiRateLimit(userId, path);
			} catch (error) {
				if (
					error instanceof ORPCError &&
					error.code === "TOO_MANY_REQUESTS"
				) {
					return { status: "RATE_LIMITED" };
				}
				throw error;
			}

			const promptText = await loadBoundProposalPromptText({
				promptVersionId: prompt.promptVersionId,
				organizationId,
			});
			if (!promptText) {
				logger.warn(`${LOG_PREFIX} Bound prompt did not render`, {
					...ids,
					promptVersionId: prompt.promptVersionId,
				});
				throw revisionFailed();
			}

			// The member's settled decisions, for a member of the owning
			// organization only (the loader above already required that).
			const [settled, responses] = await Promise.all([
				buildSettledDecisionsBlock({
					projectId: input.projectId,
					documentId: document.id,
					starterUserId: userId,
					organizationId,
				}),
				listResponsesForDocument({
					organizationId,
					documentId: document.id,
				}),
			]);
			const response =
				responses.find((row) => row.stableKey === finding.stableKey) ??
				null;
			const recommendation = finding.recommendation?.trim() || null;

			const result = await reviseProposalSection({
				organizationId,
				projectId: input.projectId,
				userId,
				documentContent: content,
				sectionKey,
				instruction: recommendation ?? finding.title,
				promptText,
				settledBlock: settled?.block ?? null,
				// Everything internal the prompt carried, and this finding's
				// own answer even when it no longer settles anything: the
				// accept checks the same texts.
				carried: buildFindingEchoCarried({
					settled,
					finding: {
						stableKey: finding.stableKey,
						title: finding.title,
						recommendation,
					},
					response,
				}),
				internalInstruction: true,
				...(signal ? { abortSignal: signal } : {}),
			});
			if (result.status !== "CANDIDATE") {
				return { status: result.status };
			}

			// A request abandoned meanwhile signs nothing.
			signal?.throwIfAborted();

			// The server's own sanity check of the splice: only the section's
			// own lines changed, and every diagram is still there.
			const spliced = spliceSectionBody(content, sectionKey, result.body);
			const preservation = spliced
				? checkPreservation({
						previous: content,
						next: spliced,
						scope: { kind: "section", sectionKey },
					})
				: null;
			const candidate = spliced
				? revisionSectionFingerprint(spliced, sectionKey)
				: undefined;
			if (!spliced || !preservation?.ok || candidate === undefined) {
				logger.info(`${LOG_PREFIX} Candidate refused`, {
					...ids,
					sectionKey,
					reason: "PRESERVATION",
					codes:
						preservation && !preservation.ok
							? [
									...new Set(
										preservation.violations.map(
											(violation) => violation.code,
										),
									),
								]
							: [],
					bodyLength: result.body.length,
				});
				return { status: "INVALID_CANDIDATE" };
			}

			const revisionToken = signRevisionToken({
				userId,
				documentId: document.id,
				runId: input.runId,
				findingId: input.findingId,
				baseVersion: document.version,
				response: response
					? { id: response.id, version: response.version }
					: null,
				sectionKey,
				sectionFingerprint: candidate,
			});

			return {
				status: "CANDIDATE",
				sectionKey,
				body: result.body,
				baseVersion: document.version,
				baseContentHash: input.baseContentHash,
				revisionToken,
			};
		},
	);

/** A fixed refusal for a revision that could not run; names no text. */
function revisionFailed(): ORPCError<"INTERNAL_SERVER_ERROR", unknown> {
	return new ORPCError("INTERNAL_SERVER_ERROR", {
		message: "The section could not be revised. Try again.",
	});
}
