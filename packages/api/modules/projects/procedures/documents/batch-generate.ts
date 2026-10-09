import { ORPCError } from "@orpc/client";
import { isAiImpersonatedRequest } from "@repo/ai/lib/chatgpt-plan/interactive-context";
import { issueAIToken } from "@repo/ai-token";
import { db } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { findRefusedCapabilities } from "../../../capabilities/assert";
import {
	documentCapabilityKey,
	proposalPromptRefusal,
} from "../../lib/dispatch-document-generation";
import { buildDocumentTitle } from "../../utils/document-title";

/**
 * The `reasonKey` a Proposal is skipped with when the Proposal artifact is on
 * and nothing is bound to its client-only Main prompt (Fizzy #2801). Not a
 * capability gate: the binding is an administrator's to fix, which the
 * message says.
 */
const PROPOSAL_PROMPT_NOT_BOUND_REASON_KEY =
	"documents.proposal-prompt-not-bound";

/**
 * Batch generate multiple documents for a project
 *
 * This endpoint:
 * 1. Creates all documents in the database with DRAFT status
 * 2. Triggers a Temporal workflow for batch generation
 * 3. Returns workflow ID and document IDs for tracking
 *
 * AUTHORIZATION: Uses canEditProject() which verifies:
 * - Personal projects: User must be the owner
 * - Org projects: User must be org member AND (project owner OR project member with EDITOR role)
 *
 * Note: organizationId is retrieved from the project record itself for the Temporal workflow,
 * so we don't need it as an input parameter.
 */
export const batchGenerateDocumentsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DOCUMENT_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/documents/batch-generate",
		tags: ["Projects", "Documents"],
		summary: "Batch generate multiple documents using AI with RAG",
	})
	.input(
		z.object({
			projectId: z.string(),
			timeZone: z.string().optional(),
			documents: z.array(
				z.object({
					type: z.enum([
						"GENERAL",
						"BUSINESS_CASE",
						"DESIGN_SYSTEM",
						"PRD",
						"PROPOSAL",
						"ARCHITECTURE",
						"TECHNICAL_SPEC",
						"USER_STORY",
						"API_SPEC",
					]),
					title: z.string(),
					prompt: z.string(),
					promptId: z
						.string()
						.optional()
						.describe(
							"Optional custom prompt ID from Prompt Library",
						),
				}),
			),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;
		const { projectId } = input;

		// Get project data
		const project = await db.project.findUnique({
			where: { id: projectId },
			include: {
				organization: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		// The capability gate, per type, before anything is written (Fizzy
		// #1930). A batch is several independent generations, so one type that
		// cannot run is skipped and reported rather than failing the rest — the
		// wizard and the pipeline both want what CAN be generated.
		//
		// Types in this same batch count as on their way: the workflow runs
		// them in dependency order, so the PRD it generates first grounds the
		// architecture document it generates next.
		const batchTypes = input.documents.map((doc) => doc.type);
		const refused = await findRefusedCapabilities({
			capabilityKeys: [
				...new Set(
					batchTypes.flatMap(
						(type) => documentCapabilityKey(type) ?? [],
					),
				),
			],
			projectId,
			userId: user.id,
			organizationId: project.organizationId ?? null,
			alsoInFlightTypes: batchTypes,
		});
		const refusedKeys = new Map(
			refused.map((entry) => [entry.gate.capabilityKey, entry]),
		);

		// A Proposal whose client-only Main prompt is unbound, with the
		// Proposal artifact on (Fizzy #2801), is refused here like a type
		// the capability gate refuses: skipped and reported, before anything
		// is written, so the rest of the batch still runs. Asked once — the
		// answer is the same for every Proposal in the batch.
		const proposalRefusal = batchTypes.includes("PROPOSAL")
			? await proposalPromptRefusal({
					documentType: "PROPOSAL",
					projectId,
					userId: user.id,
					organizationId: project.organizationId ?? null,
				})
			: null;

		const refusalFor = (
			type: string,
		): { reasonKey: string | null; message: string } | undefined => {
			if (type === "PROPOSAL" && proposalRefusal) {
				return {
					reasonKey: PROPOSAL_PROMPT_NOT_BOUND_REASON_KEY,
					message: proposalRefusal,
				};
			}
			const key = documentCapabilityKey(type);
			const entry = key ? refusedKeys.get(key) : undefined;
			return entry
				? { reasonKey: entry.gate.reasonKey, message: entry.message }
				: undefined;
		};

		const documents = input.documents.filter(
			(doc) => refusalFor(doc.type) === undefined,
		);
		const skipped = input.documents.flatMap((doc) => {
			const refusal = refusalFor(doc.type);
			return refusal ? [{ type: doc.type, ...refusal }] : [];
		});
		if (documents.length === 0 && skipped.length > 0) {
			// Nothing left to run. A structured refusal naming the first missing
			// source is the honest answer; an empty workflow would not be. An
			// unbound Proposal prompt is not a capability gate, so a batch
			// refused only for that carries no gate.
			throw new ORPCError("PRECONDITION_FAILED", {
				message: skipped[0].message,
				data: { gate: refused[0]?.gate ?? null, skipped },
			});
		}

		// Create all documents in database with DRAFT status
		const createdDocuments = await Promise.all(
			documents.map((doc) =>
				db.projectDocument.create({
					data: {
						projectId,
						type: doc.type,
						title: buildDocumentTitle(
							doc.type,
							project.name,
							doc.title,
							{ timeZone: input.timeZone },
						),
						content: "", // Empty initially
						status: "DRAFT",
						generationPrompt: doc.prompt,
						generationProgress: 0,
					},
				}),
			),
		);

		// Get Temporal client
		const client = await getTemporalClient();

		// Issue AI token in the API layer where AI_TOKEN_SECRET is available
		// This token will be passed to Temporal activities for agent authentication
		const aiToken = await issueAIToken({
			userId: user.id,
			organizationId: project.organizationId || undefined,
			impersonated: isAiImpersonatedRequest(),
			source: "batch-document-generation",
			// Use longer expiry for batch operations (30 minutes)
			expirySeconds: 1800,
		});

		// Start batch generation workflow
		const workflowId = `batch-document-generation-${projectId}-${Date.now()}`;

		const handle = await client.workflow.start(
			"batchDocumentGenerationWorkflow",
			withCorrelationMemo({
				taskQueue: "project-documents",
				workflowId,
				args: [
					{
						projectId,
						userId: user.id,
						organizationId: project.organizationId || undefined,
						aiToken, // Pass pre-issued token to workflow
						documents: createdDocuments.map((doc, index) => ({
							id: doc.id,
							type: doc.type,
							title: doc.title,
							prompt: documents[index].prompt,
							promptId: documents[index].promptId, // NEW: Pass custom prompt ID
						})),
					},
				],
			}),
		);

		return {
			workflowId: handle.workflowId,
			runId: handle.firstExecutionRunId,
			documents: createdDocuments.map((doc) => ({
				id: doc.id,
				type: doc.type,
				title: doc.title,
				status: doc.status,
			})),
			// The types the gate refused, with why — empty when none were.
			skipped,
			message: `Batch generation started for ${createdDocuments.length} documents`,
		};
	});
