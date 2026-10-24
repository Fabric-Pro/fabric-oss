import { ORPCError } from "@orpc/client";
import {
	boundGlossyField,
	GLOSSY_EDIT_INSTRUCTION_MAX_CHARS,
	GLOSSY_EDIT_SOURCE_MAX_CHARS,
	GLOSSY_EDITABLE_KINDS,
} from "@repo/agent-prompts/glossy";
import {
	appendProposalVisualSpec,
	canEditProject,
	db,
	getLatestProposalVisualSpec,
	type Prisma,
} from "@repo/database";
import { extractGlossyVisual } from "@repo/temporal";
import { violationCode } from "@repo/utils/glossy/fact-guard";
import {
	PROPOSAL_VISUAL_TEMPLATE_OPTIONS,
	visualSpecToMermaid,
} from "@repo/utils/glossy/visual-templates";
import { mintVisualId } from "@repo/utils/proposal-artifact/visual-id-server";
import {
	type DiagramSection,
	diagramFences,
	diagramSectionAt,
	diagramSectionFingerprint,
	isFlowchartSource,
	readVisualMarker,
	VISUAL_ORIGIN,
	visualSourceHash,
} from "@repo/utils/proposal-artifact/visual-identity";
import { toMermaidFenceBody } from "@repo/utils/proposal-artifact/visual-insert";
import { z } from "zod";
import {
	enforceAiRateLimit,
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { loadProposalClientDocument } from "../../lib/proposal-artifact-access";
import { requireProposalArtifactEnabled } from "../../lib/proposal-artifact-feature";

/** Usage of an edit is attributed with the visuals step's, not Glossy's. */
const PROPOSAL_VISUALS_FEATURE_KEY = "proposal-visuals";

type EditableKind = (typeof GLOSSY_EDITABLE_KINDS)[number];

const outputSchema = z.discriminatedUnion("status", [
	/**
	 * A fact-checked replacement for the fence. `fence` is the whole body,
	 * its marker line first, without the backtick lines. The editor applies
	 * it only while its own copy of the fence still has the hash it sent,
	 * still keeps `visualId` when it names one, and its copy of the section
	 * still has `sectionFingerprint` (`diagramSectionFingerprint`), the
	 * section the candidate was checked against.
	 */
	z.object({
		status: z.literal("CANDIDATE"),
		fence: z.string(),
		visualId: z.string(),
		kind: z.string(),
		sectionFingerprint: z.string(),
	}),
	/**
	 * The fence is gone, its source no longer has the hash sent, it no
	 * longer keeps the id sent, or its section changed while the candidate
	 * was drawn.
	 */
	z.object({ status: z.literal("STALE") }),
	/** The candidate showed something its section does not state. */
	z.object({
		status: z.literal("FACT_CHECK_REFUSED"),
		/** The fact guard's codes (`presence:date`), never the fact. */
		violations: z.array(z.string()),
	}),
	/** Not a flowchart, or larger than any diagram the templates draw. */
	z.object({ status: z.literal("UNSUPPORTED_DIAGRAM") }),
	z.object({ status: z.literal("AI_PROVIDER_NOT_CONFIGURED") }),
	z.object({ status: z.literal("RATE_LIMITED") }),
]);

type EditVisualOutput = z.infer<typeof outputSchema>;

/**
 * Edit with instructions (Fizzy #2946): one diagram of a Proposal in
 * artifact mode, redrawn on a person's request and returned as a candidate.
 *
 * Nothing is written to Main here. The editor applies the candidate to that
 * one node, after checking its source hash, and its normal save persists it:
 * a server-side splice would be a second writer while the collaborative room
 * is open. Only the candidate's spec row (origin INSTRUCTION) is stored, so
 * once applied the fence classifies as generated; a discarded candidate
 * leaves a row nothing references.
 *
 * The extraction runs for the project's owning organization. The section is
 * fact-checked with every diagram fence removed, so a wrong date in the old
 * diagram cannot justify itself. No style direction, Brand kit guidance or
 * settled decision is passed, for anyone: the request is the direction, and
 * those inputs are for members only.
 *
 * No audit row: it is an AI request whose result the person applies through
 * a normal save. The request and the section text are never logged or
 * echoed.
 *
 * AUTHORIZATION: `requireProposalArtifactEnabled` first (gate off → NOT_FOUND
 * for every caller), then `requireProjectPermission(DOCUMENT_UPDATE)`, then
 * `loadProposalClientDocument` (NOT_FOUND for every failure), then
 * `canEditProject` (FORBIDDEN). A project guest with edit rights may use it,
 * as they may use chat; no membership of the owning organization is needed.
 */
export const editProposalVisualProcedure = tenantProtectedProcedure
	.use(requireProposalArtifactEnabled())
	.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/documents/{documentId}/proposal-artifact/visuals/edit",
		tags: ["Projects", "Proposal artifact"],
		summary: "Edit a Proposal diagram with instructions",
		description:
			"Redraw one diagram of a Proposal on a request and return the fact-checked candidate. The document is not changed.",
	})
	.input(
		z.object({
			projectId: z.string(),
			documentId: z.string(),
			visualId: z.string().max(64).optional(),
			fenceOrdinal: z.number().int().min(0),
			fenceSourceHash: z.string().min(1).max(64),
			instruction: z
				.string()
				.trim()
				.min(1)
				.max(GLOSSY_EDIT_INSTRUCTION_MAX_CHARS)
				// The extraction reads the request as the prompt bounds it; one
				// of control characters only would reach it as no request.
				.refine(
					(value) =>
						boundGlossyField(
							value,
							GLOSSY_EDIT_INSTRUCTION_MAX_CHARS,
						) !== null,
					{ message: "The request has no readable text" },
				),
		}),
	)
	.output(outputSchema)
	.handler(
		async ({ input, context, path, signal }): Promise<EditVisualOutput> => {
			const userId = context.user.id;
			const { document, organizationId } =
				await loadProposalClientDocument({
					projectId: input.projectId,
					documentId: input.documentId,
					userId,
				});
			if (!(await canEditProject(input.projectId, userId))) {
				throw new ORPCError("FORBIDDEN", {
					message: "You don't have permission to edit this project",
				});
			}

			const located = await readFence(
				document.id,
				input.projectId,
				input.fenceOrdinal,
			);
			if (
				!located ||
				located.sourceHash !== input.fenceSourceHash ||
				!namesSentVisual(located, input.visualId)
			) {
				return { status: "STALE" };
			}
			// The bound the extraction prompt reads the current source under,
			// above the largest diagram the Proposal templates draw.
			const { source } = readVisualMarker(located.body);
			if (
				located.body.length > GLOSSY_EDIT_SOURCE_MAX_CHARS ||
				!isFlowchartSource(source)
			) {
				return { status: "UNSUPPORTED_DIAGRAM" };
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

			const latest = located.keptId
				? await getLatestProposalVisualSpec({
						projectId: input.projectId,
						documentId: document.id,
						visualId: located.keptId,
					})
				: null;
			const kind =
				latest && isEditableKind(latest.kind) ? latest.kind : "auto";

			const result = await extractGlossyVisual({
				userId,
				organizationId,
				projectId: input.projectId,
				featureKey: PROPOSAL_VISUALS_FEATURE_KEY,
				...(signal ? { abortSignal: signal } : {}),
				documentType: document.type,
				proposalArtifact: true,
				section: located.section,
				kind,
				source: "detected",
				instruction: input.instruction,
				currentSource: source,
			});
			if (result.status === "aiProviderNotConfigured") {
				return { status: "AI_PROVIDER_NOT_CONFIGURED" };
			}
			if (result.status === "dropped") {
				if (result.reason === "factCheck") {
					return {
						status: "FACT_CHECK_REFUSED",
						violations: [
							...new Set(result.violations.map(violationCode)),
						],
					};
				}
				throw editFailed();
			}
			const spec = result.spec;
			if (!isEditableKind(spec.kind)) {
				throw editFailed();
			}

			const visualId = located.keptId ?? mintVisualId();
			const body = toMermaidFenceBody(
				visualSpecToMermaid(spec, PROPOSAL_VISUAL_TEMPLATE_OPTIONS),
				visualId,
			);

			// A request abandoned meanwhile stores nothing.
			signal?.throwIfAborted();
			// Nor does one whose fence or section changed meanwhile: the
			// candidate was checked against the section as it was.
			const current = await readFence(
				document.id,
				input.projectId,
				input.fenceOrdinal,
			);
			if (
				!current ||
				current.sourceHash !== located.sourceHash ||
				current.sectionFingerprint !== located.sectionFingerprint ||
				!namesSentVisual(current, input.visualId)
			) {
				return { status: "STALE" };
			}
			await appendProposalVisualSpec({
				organizationId,
				projectId: input.projectId,
				documentId: document.id,
				visualId,
				sourceHash: visualSourceHash(body),
				kind: spec.kind,
				origin: VISUAL_ORIGIN.INSTRUCTION,
				spec: spec as unknown as Prisma.InputJsonValue,
				createdById: userId,
			});

			return {
				status: "CANDIDATE",
				fence: body,
				visualId,
				kind: spec.kind,
				sectionFingerprint: located.sectionFingerprint,
			};
		},
	);

/** A fixed refusal for an extraction that came back unusable; no text of it. */
function editFailed(): ORPCError<"INTERNAL_SERVER_ERROR", unknown> {
	return new ORPCError("INTERNAL_SERVER_ERROR", {
		message: "The diagram could not be redrawn. Try again.",
	});
}

function isEditableKind(kind: string): kind is EditableKind {
	return (GLOSSY_EDITABLE_KINDS as readonly string[]).includes(kind);
}

/**
 * Whether the fence is the diagram the request names. Two diagrams with the
 * same source in one section pass the hash and section checks alike, so a
 * request that names an id needs the fence at its ordinal to keep that id;
 * one for an unmarked or detached diagram names none.
 */
function namesSentVisual(
	fence: LocatedFence,
	visualId: string | undefined,
): boolean {
	return visualId === undefined || fence.keptId === visualId;
}

interface LocatedFence {
	/** The fence body, marker line included, with `\n` line endings. */
	body: string;
	sourceHash: string;
	/**
	 * The fence's marker id, when it is valid and no earlier fence carries
	 * it: the id the candidate keeps.
	 */
	keptId: string | null;
	/** The section holding the fence: its heading and its own body. */
	section: DiagramSection;
	/** `diagramSectionFingerprint` of that section. */
	sectionFingerprint: string;
}

/** The `ordinal`-th diagram fence of the document's Main, as stored now. */
async function readFence(
	documentId: string,
	projectId: string,
	ordinal: number,
): Promise<LocatedFence | null> {
	const main = await db.projectDocument.findFirst({
		where: { id: documentId, projectId },
		select: { content: true },
	});
	return main ? locateFence(main.content ?? "", ordinal) : null;
}

/**
 * The `ordinal`-th diagram fence of `content`, as the editor counts its
 * diagrams; null when there is none. The marker's id is kept only on its
 * first occurrence, so a second copy of a marked fence gets a fresh one.
 */
function locateFence(content: string, ordinal: number): LocatedFence | null {
	const markdown = content.replace(/\r\n?/g, "\n");
	const fences = diagramFences(markdown);
	const fence = fences[ordinal];
	const section = diagramSectionAt(markdown, ordinal);
	const sectionFingerprint = diagramSectionFingerprint(markdown, ordinal);
	if (!fence || !section || !sectionFingerprint) {
		return null;
	}
	const { visualId } = readVisualMarker(fence.value);
	const firstOccurrence =
		visualId !== null &&
		!fences
			.slice(0, ordinal)
			.some(
				(earlier) =>
					readVisualMarker(earlier.value).visualId === visualId,
			);
	return {
		body: fence.value,
		sourceHash: visualSourceHash(fence.value),
		keptId: firstOccurrence ? visualId : null,
		section,
		sectionFingerprint,
	};
}
