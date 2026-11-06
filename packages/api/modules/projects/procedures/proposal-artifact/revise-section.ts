import { ORPCError } from "@orpc/client";
import { boundGlossyField } from "@repo/agent-prompts/glossy";
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
import {
	resolveEncodedDiffMarkers,
	stripResidualDiffMarkers,
} from "@repo/utils/diff-markers";
import { fnv1aHex64 } from "@repo/utils/fnv1a";
import { isRunGuardedDocumentType } from "@repo/utils/generation-run-guard";
import { PROPOSAL_CLIENT_REVISION_AGENT_KEY } from "@repo/utils/prompt-action-catalog";
import { checkPreservation } from "@repo/utils/proposal-artifact/preservation";
import { SECTION_REVISION_INSTRUCTION_MAX_CHARS } from "@repo/utils/proposal-artifact/scoped-revision-codes";
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
	signInstructionRevisionToken,
	signRevisionToken,
} from "../../lib/proposal-revision-token";
import { FINDING_NOT_KEYED_CODE } from "./respond-to-finding";

const LOG_PREFIX = "[proposal-artifact.reviseSection]";

/** The `SECTION_KEY_MAX_LENGTH` of the save's `aiReview` descriptor. */
const SECTION_KEY_MAX_LENGTH = 2048;
const ID_MAX_LENGTH = 128;

const inputSchema = z
	.object({
		projectId: z.string(),
		documentId: z.string(),
		/** Apply recommendation: the run whose finding is applied… */
		runId: z.string().min(1).max(ID_MAX_LENGTH).optional(),
		/** …and that finding. */
		findingId: z.string().min(1).max(ID_MAX_LENGTH).optional(),
		/** Revise this section: the section of Main to revise… */
		sectionKey: z.string().min(1).max(SECTION_KEY_MAX_LENGTH).optional(),
		/** …and the member's instruction for it. */
		instruction: z
			.string()
			.trim()
			.min(1)
			.max(SECTION_REVISION_INSTRUCTION_MAX_CHARS)
			// One of control characters only would reach the model as no
			// instruction at all.
			.refine(
				(value) =>
					boundGlossyField(
						value,
						SECTION_REVISION_INSTRUCTION_MAX_CHARS,
					) !== null,
				{ message: "The instruction has no readable text" },
			)
			.optional(),
		/** The version of Main the editor holds. */
		baseVersion: z.number().int().nonnegative(),
		/** The identity of that body, as `projects.documents.update` returns it. */
		baseContentHash: z.string().min(1).max(128),
	})
	.superRefine((value, ctx) => {
		const finding =
			value.runId !== undefined || value.findingId !== undefined;
		const instruction =
			value.sectionKey !== undefined || value.instruction !== undefined;
		const completeFinding =
			value.runId !== undefined && value.findingId !== undefined;
		const completeInstruction =
			value.sectionKey !== undefined && value.instruction !== undefined;
		if (
			finding === instruction ||
			(finding && !completeFinding) ||
			(instruction && !completeInstruction)
		) {
			ctx.addIssue({
				code: "custom",
				message:
					"Name either a finding (runId and findingId) or a section and an instruction (sectionKey and instruction).",
			});
		}
	});

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
	 * its section, or the section named, is not in Main any more.
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
 * Revise one section of a Proposal's Main (Fizzy #2946) through the
 * organization's bound "Client proposal (revision)" prompt, and return the
 * candidate. Asked for in one of two ways, exactly one per request:
 *
 * - Apply recommendation (`runId` + `findingId`): one finding of the
 *   Internal Analysis, applied to the finding's section;
 * - Revise this section (`sectionKey` + `instruction`): a member's own
 *   instruction for the section they named.
 *
 * Nothing is written. The collaborative room holds the document while it is
 * open, so a server-side write would be a second writer; the editor reviews
 * the candidate and its accept saves it, and records the finding as Resolved
 * only with the revision token signed here.
 *
 * The revision rewrites the section's own lines (heading to the next
 * heading of any level); the heading stays. For a finding, its
 * recommendation (its title when it has none) is the instruction, labelled
 * internal guidance; its detail, evidence and the analysis report never
 * reach the model. A member's instruction goes to the model as their
 * request, in a block of its own, as untrusted text. The member's settled
 * decisions join the prompt either way. The candidate is checked before it
 * is returned: it must not repeat a carried answer (nor, for a finding, its
 * title or its recommendation), and spliced into Main it must change nothing
 * outside the section and no existing diagram. A member's own instruction is
 * not internal, so it is not an echo text.
 *
 * The section a member names may be any heading of Main, at any depth: the
 * editor offers it on `##` headings, and the scope check is the same for
 * every one. The preamble has no heading and is never a target.
 *
 * No audit row: it is an AI request whose result a person applies through a
 * normal save, which records its audit (a Resolved answer, or a revised
 * section). Logs carry ids, codes and lengths only, never the instruction;
 * the error capture records the instruction by its size and hash only.
 *
 * AUTHORIZATION: `requireProposalArtifactEnabled` first (gate off → NOT_FOUND
 * for every caller), then `requireProjectPermission(DOCUMENT_UPDATE)`, then
 * `loadProposalArtifactDocument` with `write: true` (edit access and
 * membership of the owning organization: a project guest is FORBIDDEN, since
 * the revision carries the member's settled decisions and findings are
 * internal), then, for a finding, the finding through `loadProposalFinding`
 * in the owning organization. Session-only, as every `protectedProcedure`:
 * no API key reaches it.
 */
export const reviseProposalSectionProcedure = tenantProtectedProcedure
	.use(requireProposalArtifactEnabled())
	.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/documents/{documentId}/proposal-artifact/findings/revise",
		tags: ["Projects", "Proposal artifact"],
		summary: "Revise a Proposal section",
		description:
			"Revise one section of a Proposal, following an analysis finding's recommendation or a member's instruction for a section they name, and return the candidate. The document is not changed. Organization members with edit access only.",
	})
	.input(inputSchema)
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
				...(input.runId !== undefined
					? { runId: input.runId, findingId: input.findingId }
					: {
							source: "INSTRUCTION",
							instructionLength: input.instruction?.length ?? 0,
						}),
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

			// What is revised, and on whose word: a finding of the analysis, or
			// a member's instruction for the section they named.
			const target =
				input.runId !== undefined && input.findingId !== undefined
					? await loadFindingTarget({
							organizationId,
							documentId: document.id,
							runId: input.runId,
							findingId: input.findingId,
							content,
						})
					: instructionTarget({
							sectionKey: input.sectionKey,
							instruction: input.instruction,
							content,
						});
			if ("status" in target) {
				return target;
			}
			const { sectionKey } = target;

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
				target.kind === "FINDING"
					? listResponsesForDocument({
							organizationId,
							documentId: document.id,
						})
					: null,
			]);
			const instructed =
				target.kind === "FINDING"
					? {
							...findingRevisionInput({
								finding: target.finding,
								settled,
								responses: responses ?? [],
							}),
							instructionSource: "FINDING" as const,
						}
					: {
							instruction: target.instruction,
							// Only what the member's block carried: their own
							// instruction is theirs to see in the section.
							carried: settled?.carried ?? {
								responseTexts: [],
								findingTitles: [],
							},
							response: null,
							instructionSource: "MEMBER" as const,
						};

			const result = await reviseProposalSection({
				organizationId,
				projectId: input.projectId,
				userId,
				documentContent: content,
				sectionKey,
				instruction: instructed.instruction,
				carried: instructed.carried,
				instructionSource: instructed.instructionSource,
				promptText,
				settledBlock: settled?.block ?? null,
				...(signal ? { abortSignal: signal } : {}),
			});
			if (result.status !== "CANDIDATE") {
				return { status: result.status };
			}

			// A request abandoned meanwhile signs nothing.
			signal?.throwIfAborted();

			// The candidate as the editor's save will store it: diff markers
			// percent-encoded into a destination are resolved now, so the link
			// the person reviews is the one the accept keeps.
			const body = resolveEncodedDiffMarkers(result.body);

			// The server's own sanity check of the splice: only the section's
			// own lines changed, and every diagram is still there.
			const spliced = spliceSectionBody(content, sectionKey, body);
			const preservation = spliced
				? checkPreservation({
						previous: content,
						next: spliced,
						scope: { kind: "section", sectionKey },
					})
				: null;
			// The token vouches for the section as the editor's save stores it,
			// which resolves diff markers an earlier accept percent-encoded into
			// a destination the candidate kept.
			const candidate = spliced
				? revisionSectionFingerprint(
						stripResidualDiffMarkers(spliced),
						sectionKey,
					)
				: undefined;
			if (!spliced || !preservation?.ok || candidate === undefined) {
				logger.info(`${LOG_PREFIX} Candidate refused`, {
					...ids,
					// Its heading path: the hash and length only.
					sectionKeyHash: fnv1aHex64(sectionKey),
					sectionKeyLength: sectionKey.length,
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
					bodyLength: body.length,
				});
				return { status: "INVALID_CANDIDATE" };
			}

			const revisionToken =
				target.kind === "FINDING"
					? signRevisionToken({
							userId,
							documentId: document.id,
							runId: target.runId,
							findingId: target.findingId,
							baseVersion: document.version,
							response: instructed.response
								? {
										id: instructed.response.id,
										version: instructed.response.version,
									}
								: null,
							sectionKey,
							sectionFingerprint: candidate,
						})
					: signInstructionRevisionToken({
							userId,
							documentId: document.id,
							baseVersion: document.version,
							sectionKey,
							sectionFingerprint: candidate,
						});

			return {
				status: "CANDIDATE",
				sectionKey,
				body,
				baseVersion: document.version,
				baseContentHash: input.baseContentHash,
				revisionToken,
			};
		},
	);

type FindingRecord = Awaited<ReturnType<typeof loadProposalFinding>>["finding"];

type RevisionTarget =
	| {
			kind: "FINDING";
			sectionKey: string;
			runId: string;
			findingId: string;
			finding: FindingRecord & { stableKey: string };
	  }
	| { kind: "INSTRUCTION"; sectionKey: string; instruction: string };

/** Whether `sectionKey` names a section of `content` with a heading. */
function hasHeadedSection(content: string, sectionKey: string): boolean {
	// Only a section with a heading is revised: the preamble has none.
	if (sectionKey === DOCUMENT_SECTION_KEY) {
		return false;
	}
	const current = findSection(buildSectionMap(content), sectionKey);
	return current !== undefined && current.headingText !== null;
}

/**
 * The finding to apply, in the owning organization, and its section as Main
 * holds it: refused when it has no key, answered when its section is gone
 * or changed since the analysis.
 */
async function loadFindingTarget(args: {
	organizationId: string;
	documentId: string;
	runId: string;
	findingId: string;
	content: string;
}): Promise<
	| RevisionTarget
	| { status: "SECTION_NOT_FOUND" }
	| { status: "FINDING_SECTION_CHANGED" }
> {
	const { finding } = await loadProposalFinding({
		organizationId: args.organizationId,
		documentId: args.documentId,
		runId: args.runId,
		findingId: args.findingId,
	});
	if (finding.stableKey === null) {
		throw new ORPCError("PRECONDITION_FAILED", {
			message: "Re-run the analysis to apply this finding.",
			data: { code: FINDING_NOT_KEYED_CODE },
		});
	}
	const sectionKey = finding.sectionKey;
	if (sectionKey === null || !hasHeadedSection(args.content, sectionKey)) {
		return { status: "SECTION_NOT_FOUND" };
	}
	const current = findSection(buildSectionMap(args.content), sectionKey);
	if (finding.sectionHash !== current?.proseHash) {
		return { status: "FINDING_SECTION_CHANGED" };
	}
	return {
		kind: "FINDING",
		sectionKey,
		runId: args.runId,
		findingId: args.findingId,
		finding: { ...finding, stableKey: finding.stableKey },
	};
}

/** The section a member named, when Main has it with a heading. */
function instructionTarget(args: {
	sectionKey: string | undefined;
	instruction: string | undefined;
	content: string;
}): RevisionTarget | { status: "SECTION_NOT_FOUND" } {
	// The input schema requires both together; this narrows them. The
	// model gets the instruction as the schema bounded it: whitespace
	// folded, control characters removed.
	const instruction =
		args.instruction === undefined
			? null
			: boundGlossyField(
					args.instruction,
					SECTION_REVISION_INSTRUCTION_MAX_CHARS,
				);
	if (args.sectionKey === undefined || instruction === null) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Name a section and an instruction.",
		});
	}
	if (!hasHeadedSection(args.content, args.sectionKey)) {
		return { status: "SECTION_NOT_FOUND" };
	}
	return {
		kind: "INSTRUCTION",
		sectionKey: args.sectionKey,
		instruction,
	};
}

/**
 * A finding's instruction (its recommendation, or its title when it has
 * none), the internal texts the candidate must not repeat (everything the
 * prompt carried, and this finding's own answer even when it no longer
 * settles anything: the accept checks the same texts), and the finding's
 * current answer the token is signed against.
 */
function findingRevisionInput(args: {
	finding: FindingRecord & { stableKey: string };
	settled: Awaited<ReturnType<typeof buildSettledDecisionsBlock>>;
	responses: Awaited<ReturnType<typeof listResponsesForDocument>>;
}) {
	const { finding } = args;
	const response =
		args.responses.find((row) => row.stableKey === finding.stableKey) ??
		null;
	const recommendation = finding.recommendation?.trim() || null;
	return {
		instruction: recommendation ?? finding.title,
		carried: buildFindingEchoCarried({
			settled: args.settled,
			finding: {
				stableKey: finding.stableKey,
				title: finding.title,
				recommendation,
			},
			response,
		}),
		response,
	};
}

/** A fixed refusal for a revision that could not run; names no text. */
function revisionFailed(): ORPCError<"INTERNAL_SERVER_ERROR", unknown> {
	return new ORPCError("INTERNAL_SERVER_ERROR", {
		message: "The section could not be revised. Try again.",
	});
}
