import { ORPCError } from "@orpc/client";
import {
	FindingResponseChangedError,
	listResponsesForDocument,
	type Prisma,
	type ProjectDocument,
	ProposalArtifactTenantError,
	recordAuditTx,
	sanitizeContent,
	writeResolvedFindingResponse,
} from "@repo/database";
import { logger } from "@repo/logs";
import { preserveVisualSlots } from "@repo/utils/glossy/visual-slots";
import type { PreservationScope } from "@repo/utils/proposal-artifact/preservation";
import {
	SCOPED_REVISION_REFUSAL,
	type ScopedRevisionRefusalCode,
} from "@repo/utils/proposal-artifact/scoped-revision-codes";
import {
	buildSectionMap,
	DOCUMENT_SECTION_KEY,
	findSection,
} from "@repo/utils/proposal-artifact/section-hash";
import { preserveVisualMarkers } from "@repo/utils/proposal-artifact/visual-identity";
import { normalizeQuoteArtifacts } from "@repo/utils/quote-artifacts";
import { z } from "zod";
import {
	type AuditRequestContext,
	auditRequestFields,
	resolveActor,
} from "../../../lib/audit";
import { assertProjectPermission, Permissions } from "../../../orpc/procedures";
import { checkClientProposalMain } from "./client-proposal-main-check";
import {
	loadProposalArtifactDocument,
	loadProposalFinding,
} from "./proposal-artifact-access";
import {
	revisionSectionFingerprint,
	verifyRevisionToken,
} from "./proposal-revision-token";

/**
 * The AI accept on a client-document Proposal's Main (Fizzy #2946).
 *
 * The editor's accept of a chat proposal (`CHAT`) or of a finding-driven
 * revision (`FINDING`) names itself to `projects.documents.update` with an
 * `aiReview` descriptor. Before the guarded write the server normalizes the
 * body to what the save would store, checks that it kept everything outside
 * its target and every existing diagram (`checkPreservation`), and that it
 * repeats no internal answer, finding title or recommendation
 * (`checkResponseEcho`). Both checks live in `client-proposal-main-check.ts`,
 * which the MCP and v1 whole-body writes run too. A `FINDING` accept also
 * records the finding as Resolved, with its audit row, in the write's own
 * transaction.
 *
 * Refusals are `PRECONDITION_FAILED` with a `SCOPED_REVISION_REFUSAL` code;
 * their details and every log here carry keys and codes, never text.
 */

const SECTION_KEY_MAX_LENGTH = 2048;
const SECTION_KEYS_MAX = 1000;
const ID_MAX_LENGTH = 128;
const REVISION_TOKEN_MAX_LENGTH = 8192;

export const documentAiReviewSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("CHAT"),
		/**
		 * The previous body's section keys inside every subtree the chat
		 * patched. Absent from an agent that predates them: then only the
		 * diagrams and the echo are checked.
		 */
		patchedSectionKeys: z
			.array(z.string().min(1).max(SECTION_KEY_MAX_LENGTH))
			.max(SECTION_KEYS_MAX)
			.optional(),
	}),
	z.object({
		kind: z.literal("FINDING"),
		/** The analysis run whose finding's recommendation was applied. */
		runId: z.string().min(1).max(ID_MAX_LENGTH),
		findingId: z.string().min(1).max(ID_MAX_LENGTH),
		/** The token `reviseSection` returned with the candidate. */
		revisionToken: z.string().min(1).max(REVISION_TOKEN_MAX_LENGTH),
	}),
]);

type DocumentAiReview = z.infer<typeof documentAiReviewSchema>;

/**
 * The version description of an AI accept the client sent none for. Generic
 * on purpose: version history is shown to project guests, so it never names
 * the finding or carries any internal analysis text.
 */
const AI_ACCEPT_CHANGE_DESCRIPTIONS: Record<DocumentAiReview["kind"], string> =
	{
		CHAT: "Assistant edit",
		FINDING: "Applied a review recommendation",
	};

export interface ReviewedAiSave {
	/** The body to save: the accepted body as the save stores it. */
	content: string;
	/** The version description to use when the client sent none. */
	changeDescription: string;
	/** For `FINDING`: the Resolved write, run in the save's transaction. */
	inTransaction?: (
		tx: Prisma.TransactionClient,
		saved: ProjectDocument,
	) => Promise<void>;
}

function refuse(
	code: ScopedRevisionRefusalCode,
	message: string,
	details?: Record<string, unknown>,
): ORPCError<"PRECONDITION_FAILED", unknown> {
	return new ORPCError("PRECONDITION_FAILED", {
		message,
		data: { code, ...details },
	});
}

function tokenInvalid(): ORPCError<"PRECONDITION_FAILED", unknown> {
	return refuse(
		SCOPED_REVISION_REFUSAL.REVISION_TOKEN_INVALID,
		"This revision can no longer be applied. Ask for the revision again.",
	);
}

/**
 * The accepted body as the save will store it: quote artifacts repaired, and
 * the visual slots and diagram markers of the stored body kept, as "Update
 * using context" saves a confirmed body.
 */
function normalizeAcceptedBody(stored: string, next: string): string {
	return sanitizeContent(
		normalizeQuoteArtifacts(
			preserveVisualMarkers(stored, preserveVisualSlots(stored, next)),
		),
	);
}

/** The FINDING half: who may resolve it, and what the token vouches for. */
interface FindingTarget {
	organizationId: string;
	stableKey: string;
	sectionKey: string;
	title: string;
	recommendation: string | null;
	/** The finding's current answer text; null when it has none. */
	responseText: string | null;
	runId: string;
	token: NonNullable<ReturnType<typeof verifyRevisionToken>>;
}

async function loadFindingTarget(args: {
	review: Extract<DocumentAiReview, { kind: "FINDING" }>;
	projectId: string;
	documentId: string;
	userId: string;
	expectedVersion: number;
	storedContent: string;
}): Promise<FindingTarget> {
	// Resolving a finding is an internal write: the document permission, edit
	// access to the project and membership of the owning organization, as
	// for answering a finding. A project guest is refused here.
	await assertProjectPermission(
		args.projectId,
		args.userId,
		Permissions.DOCUMENT_UPDATE,
	);
	const { organizationId } = await loadProposalArtifactDocument({
		projectId: args.projectId,
		documentId: args.documentId,
		userId: args.userId,
		write: true,
	});
	const { run, finding } = await loadProposalFinding({
		organizationId,
		documentId: args.documentId,
		runId: args.review.runId,
		findingId: args.review.findingId,
	});

	const token = verifyRevisionToken(args.review.revisionToken);
	if (
		!token ||
		token.userId !== args.userId ||
		token.documentId !== args.documentId ||
		token.runId !== run.id ||
		token.findingId !== finding.id ||
		token.baseVersion !== args.expectedVersion ||
		finding.stableKey === null ||
		finding.sectionKey === null ||
		finding.sectionKey === DOCUMENT_SECTION_KEY ||
		token.sectionKey !== finding.sectionKey
	) {
		// A finding without a key or a section is never revised, so a token
		// naming one was not issued for it.
		throw tokenInvalid();
	}

	// The finding is about the section as the analysis read it. A section
	// edited since is not the one the recommendation was written for.
	const storedSection = findSection(
		buildSectionMap(args.storedContent),
		finding.sectionKey,
	);
	if (!storedSection || storedSection.proseHash !== finding.sectionHash) {
		throw refuse(
			SCOPED_REVISION_REFUSAL.FINDING_SECTION_CHANGED,
			"The section changed after the analysis raised this finding, so the revision was not saved.",
			{ sectionKey: finding.sectionKey },
		);
	}

	// The finding's own answer, which the revision's echo check carried
	// whether or not it still settles anything.
	const stableKey = finding.stableKey;
	const response =
		(
			await listResponsesForDocument({
				organizationId,
				documentId: args.documentId,
			})
		).find((row) => row.stableKey === stableKey) ?? null;

	return {
		organizationId,
		stableKey,
		sectionKey: finding.sectionKey,
		title: finding.title,
		recommendation: finding.recommendation,
		responseText: response?.text ?? null,
		runId: run.id,
		token,
	};
}

/**
 * Check an AI accept on a client-document Proposal and prepare its save.
 * The caller has already refused a save under a live run, required the base
 * and judged the descriptor applicable; `stored` is the body at that base.
 */
export async function reviewAiAcceptedSave(args: {
	review: DocumentAiReview;
	projectId: string;
	documentId: string;
	/** The project's owning organization. */
	owningOrganizationId: string;
	stored: { content: string; version: number };
	content: string;
	expectedVersion: number;
	context: AuditRequestContext & { user: { id: string } };
}): Promise<ReviewedAiSave> {
	const { review, context } = args;
	const userId = context.user.id;
	const ids = {
		documentId: args.documentId,
		projectId: args.projectId,
		organizationId: args.owningOrganizationId,
		kind: review.kind,
	};

	const finding =
		review.kind === "FINDING"
			? await loadFindingTarget({
					review,
					projectId: args.projectId,
					documentId: args.documentId,
					userId,
					expectedVersion: args.expectedVersion,
					storedContent: args.stored.content,
				})
			: null;

	const next = normalizeAcceptedBody(args.stored.content, args.content);

	// Structure: what the change was allowed to touch.
	const scope: PreservationScope = finding
		? { kind: "section", sectionKey: finding.sectionKey }
		: {
				kind: "chat",
				...(review.kind === "CHAT" && review.patchedSectionKeys
					? { patchedSectionKeys: review.patchedSectionKeys }
					: {}),
			};
	if (review.kind === "CHAT" && !review.patchedSectionKeys) {
		// An agent from before section keys: diagrams and echo only.
		logger.info(
			ids,
			"[document-ai-review] chat accept without patched section keys; sections not checked",
		);
	}
	const verdict = await checkClientProposalMain({
		projectId: args.projectId,
		documentId: args.documentId,
		owningOrganizationId: args.owningOrganizationId,
		userId,
		previous: args.stored.content,
		next,
		scope,
		finding: finding
			? {
					stableKey: finding.stableKey,
					title: finding.title,
					recommendation: finding.recommendation,
					responseText: finding.responseText,
				}
			: null,
	});
	if (!verdict.ok) {
		if (verdict.code === SCOPED_REVISION_REFUSAL.RESPONSE_ECHOED) {
			logger.info(
				{ ...ids, stableKeys: verdict.stableKeys },
				"[document-ai-review] accept refused: internal wording echoed",
			);
			throw refuse(
				SCOPED_REVISION_REFUSAL.RESPONSE_ECHOED,
				"The change repeats internal analysis wording, so it was not saved.",
			);
		}
		const { code, violations } = verdict;
		logger.info(
			{ ...ids, code, violations },
			"[document-ai-review] accept refused: change outside its target",
		);
		throw refuse(
			code,
			code === SCOPED_REVISION_REFUSAL.CHANGED_DIAGRAM
				? "The change altered an existing diagram, so it was not saved."
				: "The change altered sections it did not target, so it was not saved.",
			{ violations },
		);
	}

	const changeDescription = AI_ACCEPT_CHANGE_DESCRIPTIONS[review.kind];

	if (!finding) {
		return { content: next, changeDescription };
	}

	// The saved section must be the one the server produced: a hand edit of
	// the candidate, a changed link or image destination included, is not
	// the applied recommendation.
	const isSignedSection = (body: string) =>
		revisionSectionFingerprint(body, finding.sectionKey) ===
		finding.token.sectionFingerprint;
	if (!isSignedSection(next)) {
		throw tokenInvalid();
	}

	return {
		content: next,
		changeDescription,
		inTransaction: async (tx, saved) => {
			// Read off the row as stored, so the answer's hash is the saved
			// section's own.
			const sectionHash = findSection(
				buildSectionMap(saved.content),
				finding.sectionKey,
			)?.proseHash;
			if (sectionHash === undefined || !isSignedSection(saved.content)) {
				throw tokenInvalid();
			}
			let response: Awaited<
				ReturnType<typeof writeResolvedFindingResponse>
			>;
			try {
				response = await writeResolvedFindingResponse(tx, {
					organizationId: finding.organizationId,
					projectId: args.projectId,
					documentId: args.documentId,
					stableKey: finding.stableKey,
					findingTitle: finding.title,
					answeredRunId: finding.runId,
					sectionKey: finding.sectionKey,
					sectionHash,
					authorId: userId,
					expected: finding.token.response,
				});
			} catch (error) {
				if (error instanceof FindingResponseChangedError) {
					throw refuse(
						SCOPED_REVISION_REFUSAL.FINDING_RESPONSE_CHANGED,
						"The answer to this finding changed while the revision was open, so it was not saved.",
					);
				}
				if (error instanceof ProposalArtifactTenantError) {
					throw new ORPCError("NOT_FOUND", {
						message: "Finding not found",
					});
				}
				throw error;
			}
			const fields = auditRequestFields(context);
			await recordAuditTx(tx, {
				action: "project.document_analysis.resolved",
				category: "project",
				outcome: "success",
				actor: resolveActor(context, undefined),
				organizationId: finding.organizationId,
				projectId: args.projectId,
				resource: {
					type: "project_document",
					id: args.documentId,
					name: null,
				},
				metadata: {
					stableKey: response.stableKey,
					runId: finding.runId,
					version: response.version,
				},
				ipAddress: fields.ipAddress,
				userAgent: fields.userAgent,
				requestId: fields.requestId,
				sessionId: fields.sessionId,
				correlationId: fields.correlationId,
			});
		},
	};
}
