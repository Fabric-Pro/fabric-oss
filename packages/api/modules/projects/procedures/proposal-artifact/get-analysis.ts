import {
	authorMaySettleDecisions,
	canEditProject,
	db,
	type FindingResponseCurrent,
	type FindingResponseView,
	getAnalysisForCurrentContent,
	isOrganizationMember,
	listResponsesForDocument,
	PROPOSAL_ANALYSIS_KINDS,
	PROPOSAL_ANALYSIS_STATUSES,
	PROPOSAL_FINDING_RESPONSE_KINDS,
	PROPOSAL_FINDING_SEVERITIES,
	PROPOSAL_FINDING_TYPES,
} from "@repo/database";
import { hasPermission } from "@repo/permissions";
import {
	type DerivedResponse,
	deriveFindingStates,
	FINDING_STATES,
	NEEDS_REVIEW_REASONS,
	RESPONSE_STATES,
} from "@repo/utils/proposal-artifact/finding-state";
import {
	buildSectionMap,
	documentProseHash,
} from "@repo/utils/proposal-artifact/section-hash";
import { z } from "zod";
import { resolveEffectiveProjectPermissions } from "../../../../lib/effective-project-permissions";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { loadProposalArtifactDocument } from "../../lib/proposal-artifact-access";
import {
	buildProposalEvidenceResolver,
	proposalEvidenceSchema,
} from "../../lib/proposal-artifact-evidence";
import { requireProposalArtifactEnabled } from "../../lib/proposal-artifact-feature";

/**
 * Why the settled-decisions feed leaves an answer out of later generations:
 * it needs review, or its author no longer holds edit rights in the owning
 * organization. Needs review wins when both hold.
 */
const SETTLED_SKIP_REASONS = ["NEEDS_REVIEW", "AUTHOR_RIGHTS"] as const;

const authorSchema = z
	.object({ id: z.string(), name: z.string().nullable() })
	.nullable();

/** An answer as saved: what a write returns and a stale write reports. */
export const savedAnswerSchema = z.object({
	/**
	 * The answer's row id. With `version`, the compare-and-swap token the next
	 * write or clear must name: an answer cleared and given again is a new row
	 * back at version 1, so the version alone could not tell it from the one
	 * the member saw.
	 */
	id: z.string(),
	kind: z.enum(PROPOSAL_FINDING_RESPONSE_KINDS),
	/** Null for a bare confirmation. */
	text: z.string().nullable(),
	/** With `id`, the compare-and-swap token the next write or clear must name. */
	version: z.number().int(),
	/** Null when the author's account was deleted. */
	author: authorSchema,
	updatedAt: z.date(),
});

type SavedAnswer = z.infer<typeof savedAnswerSchema>;

/** An answer as the analysis read shows it, with its derived standing. */
const responseSchema = savedAnswerSchema.extend({
	/** Why the settled-decisions feed skips it; null when it feeds. */
	settledSkipReason: z.enum(SETTLED_SKIP_REASONS).nullable(),
	/**
	 * Its section key or hash came from another hashing version, so a section
	 * comparison was skipped rather than read as a change.
	 */
	versionUnknown: z.boolean(),
});

const findingSchema = z.object({
	id: z.string(),
	position: z.number().int(),
	severity: z.enum(PROPOSAL_FINDING_SEVERITIES),
	type: z.enum(PROPOSAL_FINDING_TYPES),
	title: z.string(),
	detail: z.string(),
	recommendation: z.string().nullable(),
	/** The Main section the finding is about, when it names one. */
	sectionHeading: z.string().nullable(),
	/** The finding's identity across runs; null on findings that predate it. */
	stableKey: z.string().nullable(),
	/**
	 * False for a finding written before stable keys existed: it cannot be
	 * answered, and a re-run gives it one.
	 */
	keyed: z.boolean(),
	/** Titles of the same-key findings the run folded into this one. */
	foldedTitles: z.array(z.string()),
	state: z.enum(FINDING_STATES),
	/** Set exactly when `state` is NEEDS_REVIEW. */
	reason: z.enum(NEEDS_REVIEW_REASONS).nullable(),
	response: responseSchema.nullable(),
	/**
	 * The sources it cites, resolved against the rows that still exist;
	 * empty when the run has no source manifest to resolve them by.
	 */
	evidence: z.array(proposalEvidenceSchema),
});

const noLongerRaisedSchema = z.object({
	stableKey: z.string(),
	/** The finding's title as copied when it was answered. */
	findingTitle: z.string(),
	state: z.enum(RESPONSE_STATES),
	reason: z.enum(NEEDS_REVIEW_REASONS).nullable(),
	response: responseSchema,
});

const shownRunSchema = z.object({
	id: z.string(),
	kind: z.enum(PROPOSAL_ANALYSIS_KINDS),
	/** Always COMPLETE: only a complete run is ever shown. */
	status: z.enum(PROPOSAL_ANALYSIS_STATUSES),
	/** The document version the run analyzed; null when it had none. */
	documentVersion: z.number().int().nullable(),
	contextCount: z.number().int(),
	model: z.string().nullable(),
	startedAt: z.date().nullable(),
	completedAt: z.date().nullable(),
	createdAt: z.date(),
	updatedAt: z.date(),
});

const newerRunSchema = z.object({
	id: z.string(),
	kind: z.enum(PROPOSAL_ANALYSIS_KINDS),
	status: z.enum(["PENDING", "RUNNING", "FAILED"]),
	/** A fixed code; the page maps it to translated copy. */
	errorCode: z.string().nullable(),
	/** PENDING or RUNNING with no update for twenty minutes. */
	timedOut: z.boolean(),
	createdAt: z.date(),
});

/** What the caller may do here, by the rule the server enforces. */
const viewerSchema = z.object({
	/**
	 * May confirm, answer and clear findings and re-run the analysis: exactly
	 * the rule the write procedures enforce, so the page offers an action
	 * only when the server would take it.
	 */
	canRespond: z.boolean(),
});

const proposalAnalysisSchema = z.object({
	/**
	 * The newest COMPLETE run that describes the document's current content,
	 * else the newest COMPLETE run; null before any run completed.
	 */
	run: shownRunSchema.nullable(),
	/** The shown run describes other content than the document's current. */
	isStale: z.boolean(),
	/**
	 * The newest run created after the shown one, while it has not completed:
	 * pending, running or failed. Null when there is none.
	 */
	newerRun: newerRunSchema.nullable(),
	/** The shown run's findings in order; empty without a shown run. */
	findings: z.array(findingSchema),
	/** Answers whose key the shown run does not raise. */
	noLongerRaised: z.array(noLongerRaisedSchema),
	viewer: viewerSchema,
});

/** Display names of the given users; deleted users are simply absent. */
async function authorNames(
	authorIds: readonly string[],
): Promise<Map<string, string | null>> {
	const ids = [...new Set(authorIds)];
	if (ids.length === 0) {
		return new Map();
	}
	const users = await db.user.findMany({
		where: { id: { in: ids } },
		select: { id: true, name: true },
	});
	return new Map(users.map((user) => [user.id, user.name || null]));
}

function presentAuthor(
	authorId: string | null,
	names: ReadonlyMap<string, string | null>,
): SavedAnswer["author"] {
	return authorId
		? { id: authorId, name: names.get(authorId) ?? null }
		: null;
}

/**
 * A saved answer with its author's display name, for a write's result or a
 * stale write's report. Never carries the finding title or a tenant column.
 */
export async function presentSavedAnswer(
	answer: FindingResponseCurrent,
): Promise<SavedAnswer> {
	const names = await authorNames(answer.authorId ? [answer.authorId] : []);
	return {
		id: answer.id,
		kind: answer.kind,
		text: answer.text,
		version: answer.version,
		author: presentAuthor(answer.authorId, names),
		updatedAt: answer.updatedAt,
	};
}

/**
 * The authors whose answers still steer later generations (Fizzy #2946): a
 * member of the owning organization who may change the project's documents,
 * checked live by `authorMaySettleDecisions`, the rule the settled-decisions
 * feed asks when it builds its block, so an answer this labels "not applied"
 * is exactly one the feed leaves out. A deleted author holds nothing.
 */
async function authorsWithEditRights(input: {
	organizationId: string;
	projectId: string;
	authorIds: readonly string[];
}): Promise<Set<string>> {
	const ids = [...new Set(input.authorIds)];
	const holds = await Promise.all(
		ids.map((userId) =>
			authorMaySettleDecisions(
				userId,
				input.projectId,
				input.organizationId,
			),
		),
	);
	return new Set(ids.filter((_, index) => holds[index]));
}

/**
 * Whether the caller may confirm, answer and clear findings and re-run the
 * analysis: the rule the write procedures enforce, asked without throwing.
 *
 *  - `requireProjectPermission(DOCUMENT_UPDATE)`, decided by the resolver its
 *    middleware uses (a personal-project owner passes; an active project
 *    member row decides alone; otherwise the organization role), refusing a
 *    deleted organization;
 *  - the write gate of `loadProposalArtifactDocument`: `canEditProject` and
 *    membership of the owning organization. The read already proved project
 *    access and membership; membership is asked again so this rule stands on
 *    its own.
 *
 * Not the page's project role: that legacy role is null for an organization
 * member reaching the project through their organization role, and "owner"
 * for a creator whose role no longer grants edits.
 */
async function callerCanRespond(input: {
	organizationId: string;
	projectId: string;
	userId: string;
}): Promise<boolean> {
	const [access, canEdit, member] = await Promise.all([
		resolveEffectiveProjectPermissions(input.projectId, input.userId),
		canEditProject(input.projectId, input.userId),
		isOrganizationMember(input.userId, input.organizationId),
	]);
	const documentUpdate =
		access !== null &&
		access.source !== "none" &&
		!access.organizationDeleted &&
		(access.source === "owner" ||
			hasPermission(access.permissions, Permissions.DOCUMENT_UPDATE));
	return documentUpdate && canEdit && member;
}

/**
 * The Internal Analysis of a Proposal (Fizzy #2801, Fizzy #2946): the run
 * that describes the document's current content, every finding's state and
 * answer and the evidence it cites, the answers to findings no longer
 * raised, whether a newer run is pending, running or failed, and whether the
 * caller may respond.
 *
 * The run shown is the newest COMPLETE run whose prose hash equals the
 * current content's, else the newest COMPLETE run marked stale, so a newer
 * run that failed never hides an older complete one. Every answer's state is
 * derived here from the current content's section map and the shown run, by
 * the same derivation the settled-decisions feed uses.
 *
 * Internal review material, so only members of the project's owning
 * organization read it; a project guest is refused whatever their project
 * role. The response is built field by field: the analyzed Main body and the
 * source context stored with a run never leave the server, nor do tenant
 * columns, workflow keys or stored source URLs. Evidence shows a source's
 * text as the row holds it now, never as the run read it.
 *
 * AUTHORIZATION: `requireProposalArtifactEnabled` first (gate off → NOT_FOUND
 * for every caller), then `requireProjectPermission(DOCUMENT_READ)`, then
 * `loadProposalArtifactDocument` (document in project, project access,
 * membership of the owning organization, a Proposal).
 */
export const getProposalAnalysisProcedure = tenantProtectedProcedure
	.use(requireProposalArtifactEnabled())
	.use(requireProjectPermission(Permissions.DOCUMENT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/documents/{documentId}/proposal-artifact/analysis",
		tags: ["Projects", "Proposal artifact"],
		summary: "Get the Internal Analysis",
		description:
			"The Internal Analysis of a Proposal that describes its current content, with each finding's state, answer and evidence, the answers to findings no longer raised, the status of any newer run, and whether the caller may respond. Organization members only.",
	})
	.input(z.object({ projectId: z.string(), documentId: z.string() }))
	.output(proposalAnalysisSchema)
	.handler(async ({ input, context }) => {
		const { document, organizationId } = await loadProposalArtifactDocument(
			{
				projectId: input.projectId,
				documentId: input.documentId,
				userId: context.user.id,
				write: false,
			},
		);

		const sectionMap = buildSectionMap(document.content);
		const [read, responses] = await Promise.all([
			getAnalysisForCurrentContent({
				organizationId,
				documentId: document.id,
				currentProseHash: sectionMap.documentProseHash,
				computeProseHash: documentProseHash,
			}),
			listResponsesForDocument({
				organizationId,
				documentId: document.id,
			}),
		]);
		const shown = read.run;
		const shownFindings = shown?.findings ?? [];

		const states = deriveFindingStates<FindingResponseView>({
			responses,
			sectionMap,
			shownRun: shown
				? {
						id: shown.id,
						createdAt: shown.createdAt,
						findingKeys: shownFindings.flatMap((finding) =>
							finding.stableKey ? [finding.stableKey] : [],
						),
					}
				: null,
		});

		const authorIds = responses.flatMap((response) =>
			response.authorId ? [response.authorId] : [],
		);
		const [names, rightsHolders, resolveEvidence, canRespond] =
			await Promise.all([
				authorNames(authorIds),
				authorsWithEditRights({
					organizationId,
					projectId: input.projectId,
					authorIds,
				}),
				buildProposalEvidenceResolver({
					organizationId,
					projectId: input.projectId,
					manifest: shown?.sourceManifest ?? null,
					sourceRefs: shownFindings.flatMap(
						(finding) => finding.sourceRefs,
					),
				}),
				callerCanRespond({
					organizationId,
					projectId: input.projectId,
					userId: context.user.id,
				}),
			]);

		const presentResponse = (
			derived: DerivedResponse<FindingResponseView>,
		) => {
			const { response } = derived;
			const holdsRights =
				response.authorId !== null &&
				rightsHolders.has(response.authorId);
			return {
				id: response.id,
				kind: response.kind,
				text: response.text,
				version: response.version,
				author: presentAuthor(response.authorId, names),
				updatedAt: response.updatedAt,
				settledSkipReason:
					derived.state === "NEEDS_REVIEW"
						? ("NEEDS_REVIEW" as const)
						: holdsRights
							? null
							: ("AUTHOR_RIGHTS" as const),
				versionUnknown: derived.versionUnknown,
			};
		};

		const byKey = new Map(
			states.findings.map((finding) => [finding.stableKey, finding]),
		);

		return {
			run: shown
				? {
						id: shown.id,
						kind: shown.kind,
						status: shown.status,
						documentVersion: shown.documentVersion,
						contextCount: shown.contextCount,
						model: shown.model,
						startedAt: shown.startedAt,
						completedAt: shown.completedAt,
						createdAt: shown.createdAt,
						updatedAt: shown.updatedAt,
					}
				: null,
			isStale: read.isStale,
			newerRun: read.newerRun
				? {
						id: read.newerRun.id,
						kind: read.newerRun.kind,
						status: read.newerRun.status,
						errorCode: read.newerRun.errorCode,
						timedOut: read.newerRun.timedOut,
						createdAt: read.newerRun.createdAt,
					}
				: null,
			findings: shownFindings.map((finding) => {
				const derived = finding.stableKey
					? byKey.get(finding.stableKey)
					: undefined;
				return {
					id: finding.id,
					position: finding.position,
					severity: finding.severity,
					type: finding.type,
					title: finding.title,
					detail: finding.detail,
					recommendation: finding.recommendation,
					sectionHeading: finding.sectionHeading,
					stableKey: finding.stableKey,
					keyed: finding.stableKey !== null,
					foldedTitles: finding.foldedTitles,
					state: derived?.state ?? ("UNADDRESSED" as const),
					reason: derived?.reason ?? null,
					response: derived?.response
						? presentResponse(derived.response)
						: null,
					evidence: resolveEvidence(finding.sourceRefs),
				};
			}),
			noLongerRaised: states.noLongerRaised.map((derived) => ({
				stableKey: derived.response.stableKey,
				findingTitle: derived.response.findingTitle,
				state: derived.state,
				reason: derived.reason,
				response: presentResponse(derived),
			})),
			viewer: { canRespond },
		};
	});
