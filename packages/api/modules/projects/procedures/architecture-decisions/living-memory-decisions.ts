/**
 * Living Memory decision candidates: the decisions an AI found in synced
 * knowledge files, offered in the Decisions tab beside the meeting candidates.
 *
 * Authorization matches the meeting-candidate procedures — reading needs the
 * decision READ permission, creating and dismissing need CREATE, and every
 * handler re-checks project access — plus `requireInputOrgPermission`, so a
 * caller cannot pair their own project with another organization's id.
 */
import { ORPCError } from "@orpc/client";
import {
	countLivingMemoryFilesAwaitingDecisionScan,
	createDecisionFromLivingMemoryCandidate,
	dismissLivingMemoryDecision,
	getArchitectureDecision,
	getLivingMemoryDecisionCandidate,
	hasProjectAccess,
	LIVING_MEMORY_DECISION_SOURCE_KIND,
	listLivingMemoryDecisionCandidates,
	listLivingMemoryLimitedFiles,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	completeCapturedDecision,
	deriveCapturedDecisionTitle,
} from "../../lib/captured-decision";
import { startLivingMemoryFirstSyncScan } from "../../lib/living-memory-decision-scan-workflow";

async function assertProjectAccess(
	projectId: string,
	userId: string,
	organizationId: string | undefined,
): Promise<void> {
	if (!(await hasProjectAccess(projectId, userId, organizationId))) {
		throw new ORPCError("FORBIDDEN", {
			message: "You don't have access to this project",
		});
	}
}

function convertedCandidateError(): ORPCError<"CONFLICT", unknown> {
	return new ORPCError("CONFLICT", {
		message: "A decision was already created from this suggestion",
	});
}

export const listLivingMemoryDecisionCandidatesProcedure =
	tenantProtectedProcedure
		.use(requireInputOrgPermission(Permissions.ARCHITECTURE_DECISION_READ))
		.use(requireProjectPermission(Permissions.ARCHITECTURE_DECISION_READ))
		.route({
			method: "GET",
			path: "/projects/{projectId}/living-memory-decision-candidates",
			tags: ["Projects", "Architecture Decisions"],
			summary:
				"List decisions found in Living Memory files as candidate ADL entries",
		})
		.input(
			z.object({
				projectId: z.string(),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.handler(async ({ input, context }) => {
			const organizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);
			await assertProjectAccess(
				input.projectId,
				context.user.id,
				organizationId,
			);

			const [candidates, filesNotScanned, limitedFiles] =
				await Promise.all([
					listLivingMemoryDecisionCandidates({
						projectId: input.projectId,
						organizationId,
					}),
					countLivingMemoryFilesAwaitingDecisionScan({
						projectId: input.projectId,
						organizationId,
					}),
					listLivingMemoryLimitedFiles({
						projectId: input.projectId,
						organizationId,
					}),
				]);
			return { candidates, filesNotScanned, limitedFiles };
		});

export const scanLivingMemoryFirstSyncFilesProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.ARCHITECTURE_DECISION_CREATE))
	.use(requireProjectPermission(Permissions.ARCHITECTURE_DECISION_CREATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/living-memory-decision-candidates/scan-first-sync",
		tags: ["Projects", "Architecture Decisions"],
		summary:
			"Read the synced files not yet read for decisions, using one AI request per file",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		await assertProjectAccess(
			input.projectId,
			context.user.id,
			organizationId,
		);
		const fileCount = await countLivingMemoryFilesAwaitingDecisionScan({
			projectId: input.projectId,
			organizationId,
		});
		if (fileCount === 0) {
			return { fileCount, alreadyRunning: false };
		}
		const started = await startLivingMemoryFirstSyncScan({
			projectId: input.projectId,
			organizationId: organizationId ?? null,
			requestedByUserId: context.user.id,
		});
		return { fileCount, alreadyRunning: !started };
	});

export const createDecisionFromLivingMemoryProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.ARCHITECTURE_DECISION_CREATE))
	.use(requireProjectPermission(Permissions.ARCHITECTURE_DECISION_CREATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/architecture-decisions/from-living-memory",
		tags: ["Projects", "Architecture Decisions"],
		summary:
			"Create a draft ADL entry from a decision found in a Living Memory file",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			extractionId: z.string(),
			decisionIndex: z.number().int().min(0),
			title: z.string().max(255).optional(),
			/**
			 * "Create as update": the existing decision this candidate most
			 * likely updates. The new decision is linked to it and records it
			 * as `sourceMetadata.supersedes`; the existing one is not changed
			 * until a reviewer accepts the update, which marks it superseded.
			 */
			updatesDecisionId: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		await assertProjectAccess(input.projectId, user.id, organizationId);

		const lookup = await getLivingMemoryDecisionCandidate({
			projectId: input.projectId,
			organizationId,
			extractionId: input.extractionId,
			decisionIndex: input.decisionIndex,
		});
		switch (lookup.status) {
			case "found":
				break;
			case "not_found":
				throw new ORPCError("NOT_FOUND", {
					message: "That Living Memory decision could not be found",
				});
			case "stale":
				throw new ORPCError("CONFLICT", {
					message:
						"The file changed since this decision was found. Review its current decisions instead.",
				});
			case "converted":
				throw convertedCandidateError();
			default: {
				const unhandled: never = lookup;
				throw new Error(
					`Unhandled candidate lookup: ${String(unhandled)}`,
				);
			}
		}
		const { candidate } = lookup;

		const updates = input.updatesDecisionId
			? await getArchitectureDecision({
					id: input.updatesDecisionId,
					projectId: input.projectId,
				})
			: null;
		if (input.updatesDecisionId && !updates) {
			throw new ORPCError("NOT_FOUND", {
				message: "The decision to update could not be found",
			});
		}

		// The lookup above answers `converted` for a candidate used earlier;
		// this create re-checks under a lock, so a concurrent second request
		// (a double click) gets the same answer instead of a duplicate.
		const creation = await createDecisionFromLivingMemoryCandidate(
			candidate,
			{
				projectId: input.projectId,
				createdById: user.id,
				editedByName: user.name || user.email || "Unknown",
				title:
					input.title?.trim() ||
					deriveCapturedDecisionTitle(candidate.text),
				decision: candidate.text,
				contextProblem: updates
					? `Captured from the Living Memory file "${candidate.sourcePath}" as a possible update to ${updates.identifier}. Review and complete the context, rationale, and participants.`
					: `Captured from the Living Memory file "${candidate.sourcePath}". Review and complete the context, rationale, and participants.`,
				rationale: candidate.rationale ?? "",
				status: "PROPOSED",
				decisionDate: candidate.extractedAt,
				relatedDecisionIds: updates ? [updates.id] : [],
				sourceKind: LIVING_MEMORY_DECISION_SOURCE_KIND,
				sourceMetadata: {
					contextId: candidate.contextId,
					contentHash: candidate.contentHash,
					sourcePath: candidate.sourcePath,
					index: candidate.decisionIndex,
					originalText: candidate.text,
					...(updates ? { supersedes: updates.id } : {}),
					// Re-read by the lookup: only a work item the project
					// still has is carried over.
					...(candidate.workItem
						? { workItem: candidate.workItem }
						: {}),
				},
				userId: user.id,
				organizationId,
			},
		);
		if (creation.status === "converted") {
			throw convertedCandidateError();
		}

		return {
			decision: await completeCapturedDecision(creation.decision, {
				projectId: input.projectId,
				user,
				organizationId,
			}),
		};
	});

export const dismissLivingMemoryDecisionProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.ARCHITECTURE_DECISION_CREATE))
	.use(requireProjectPermission(Permissions.ARCHITECTURE_DECISION_CREATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/living-memory-decision-candidates/dismiss",
		tags: ["Projects", "Architecture Decisions"],
		summary:
			"Dismiss a decision found in a Living Memory file so it isn't re-suggested",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			extractionId: z.string(),
			decisionIndex: z.number().int().min(0),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		await assertProjectAccess(
			input.projectId,
			context.user.id,
			organizationId,
		);
		const ok = await dismissLivingMemoryDecision({
			projectId: input.projectId,
			organizationId,
			extractionId: input.extractionId,
			decisionIndex: input.decisionIndex,
		});
		if (!ok) {
			throw new ORPCError("NOT_FOUND", {
				message: "That Living Memory decision could not be found",
			});
		}
		return { success: true };
	});
