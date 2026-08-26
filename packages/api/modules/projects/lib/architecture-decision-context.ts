/**
 * AC5 — Architecture Decision Log entries as AI context.
 *
 * Rather than build a parallel embedding pipeline, each ADL entry is mirrored
 * into a `ProjectContext` row (type `ARCHITECTURE_DECISION`) and embedded via
 * the existing `contextEmbeddingWorkflow`. Retrieval is already type-agnostic,
 * so decisions surface to the AI exactly like every other project context.
 *
 * All embedding work is best-effort and fire-and-forget — a failure here must
 * never block the ADL create/update/delete it accompanies.
 */

import {
	createContext,
	db,
	deleteContext,
	getContextById,
	setArchitectureDecisionContextId,
	updateContext,
} from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";

/** Resolve display names for participant user ids (best-effort; falls back to id). */
export async function resolveParticipantNames(
	userIds: string[],
): Promise<string[]> {
	if (userIds.length === 0) {
		return [];
	}
	const users = await db.user.findMany({
		where: { id: { in: userIds } },
		select: { id: true, name: true, email: true },
	});
	const byId = new Map(users.map((u) => [u.id, u.name || u.email || u.id]));
	return userIds.map((id) => byId.get(id) ?? id);
}

export interface ResolvedParticipant {
	id: string;
	name: string;
	image: string | null;
}

/**
 * Resolve participant user ids → { id, name, image } (order preserved; unknown
 * ids fall back to the id). Used to render member avatars on decisions.
 */
export async function resolveParticipants(
	userIds: string[],
): Promise<ResolvedParticipant[]> {
	if (userIds.length === 0) {
		return [];
	}
	const users = await db.user.findMany({
		where: { id: { in: userIds } },
		select: { id: true, name: true, email: true, image: true },
	});
	const byId = new Map(users.map((u) => [u.id, u]));
	return userIds.map((id) => {
		const u = byId.get(id);
		return { id, name: u?.name || u?.email || id, image: u?.image ?? null };
	});
}

/**
 * Per-status instruction embedded with every record — the crux of AC5. It tells
 * the model how much weight to give a decision and whether to treat it as
 * binding, historical, or off-limits, so it won't re-propose a REJECTED option
 * or follow a SUPERSEDED one.
 */
const STATUS_AI_GUIDANCE: Record<string, string> = {
	PROPOSED:
		"PROPOSED — under discussion, not yet agreed. Weigh it, but it is not binding.",
	ACCEPTED:
		"ACCEPTED — an active, agreed decision. Treat it as a binding constraint and follow it.",
	DEPRECATED:
		"DEPRECATED — discouraged for new work. Avoid relying on it going forward.",
	SUPERSEDED:
		"SUPERSEDED — replaced by a newer decision (see Relationships). Follow the newer one, not this.",
	REJECTED:
		"REJECTED — this option was considered and ruled out. Do NOT propose or reintroduce it.",
};

export interface DecisionRelationLine {
	identifier: string;
	kind: "supersedes" | "supersededBy" | "related";
}

/**
 * Compose the text embedded for AI retrieval. Each block is self-contained and
 * machine-actionable: status carries an explicit instruction, endorsement marks
 * human-vouched vs AI-captured provenance, and relationships name the other
 * ADRs by identifier so the model can follow the chain.
 */
export function buildArchitectureDecisionContextContent(input: {
	identifier: string;
	title: string;
	status: string;
	domain?: string | null;
	contextProblem: string;
	decision: string;
	rationale: string;
	decisionDrivers?: string | null;
	alternativesConsidered?: string | null;
	consequences?: string | null;
	participantsText?: string | null;
	participantNames?: string[];
	decisionDate: Date;
	vouched?: { byName?: string | null; at?: Date | null } | null;
	sourceKind?: string | null;
	relations?: DecisionRelationLine[];
}): string {
	const participants = [
		...(input.participantNames ?? []),
		input.participantsText,
	]
		.filter((p): p is string => Boolean(p?.trim()))
		.join(", ");

	const lines = [
		`Architecture Decision ${input.identifier}: ${input.title}`,
		`Status: ${STATUS_AI_GUIDANCE[input.status] ?? input.status}`,
	];

	// Endorsement / provenance — how much the AI should trust this record.
	if (input.vouched?.at) {
		const by = input.vouched.byName ? ` by ${input.vouched.byName}` : "";
		const on = ` on ${input.vouched.at.toISOString().slice(0, 10)}`;
		lines.push(
			`Endorsement: Human-endorsed${by}${on} — a maintainer has vouched for this; treat it as settled.`,
		);
	} else {
		const captured =
			input.sourceKind === "meeting_decision"
				? " (AI-captured from a meeting)"
				: "";
		lines.push(
			`Endorsement: Not yet human-endorsed${captured} — treat as provisional and open to challenge.`,
		);
	}

	if (input.domain) {
		lines.push(`Domain: ${input.domain}`);
	}
	lines.push(`Date: ${input.decisionDate.toISOString().slice(0, 10)}`);
	if (participants) {
		lines.push(`Participants: ${participants}`);
	}
	if (input.contextProblem.trim()) {
		lines.push("", "Context / Problem:", input.contextProblem.trim());
	}
	if (input.decisionDrivers?.trim()) {
		lines.push("", "Decision Drivers:", input.decisionDrivers.trim());
	}
	if (input.decision.trim()) {
		lines.push("", "Decision:", input.decision.trim());
	}
	if (input.rationale.trim()) {
		lines.push("", "Rationale:", input.rationale.trim());
	}
	if (input.alternativesConsidered?.trim()) {
		lines.push(
			"",
			"Alternatives Considered:",
			input.alternativesConsidered.trim(),
		);
	}
	if (input.consequences?.trim()) {
		lines.push("", "Consequences:", input.consequences.trim());
	}

	const rels = input.relations ?? [];
	if (rels.length > 0) {
		lines.push("", "Relationships:");
		for (const r of rels) {
			if (r.kind === "supersedes") {
				lines.push(
					`- Supersedes ${r.identifier} (that decision is replaced — do not follow ${r.identifier}).`,
				);
			} else if (r.kind === "supersededBy") {
				lines.push(
					`- Superseded by ${r.identifier} (follow ${r.identifier} instead of this).`,
				);
			} else {
				lines.push(`- Related to ${r.identifier}.`);
			}
		}
	}

	return lines.join("\n");
}

interface SyncParams {
	decisionId: string;
	projectId: string;
	contextId: string | null;
	content: string;
	sourceTitle: string;
	userId: string;
	organizationId?: string | null;
}

/**
 * Mirror an ADL entry into a ProjectContext and (re)embed it. Creates the
 * context on first sync and stores its id back on the decision; updates the
 * content on subsequent syncs. Returns the context id (or null on failure).
 */
export async function syncArchitectureDecisionContext(
	params: SyncParams,
): Promise<string | null> {
	try {
		let contextId = params.contextId;

		if (contextId) {
			const existing = await getContextById(contextId);
			if (existing && existing.projectId === params.projectId) {
				await updateContext(contextId, {
					content: params.content,
					metadata: {
						architectureDecisionId: params.decisionId,
						sourceTitle: params.sourceTitle,
					},
				});
			} else {
				contextId = null; // row vanished — recreate below
			}
		}

		if (!contextId) {
			const created = await createContext({
				projectId: params.projectId,
				type: "ARCHITECTURE_DECISION",
				content: params.content,
				sourceTitle: params.sourceTitle,
				metadata: {
					architectureDecisionId: params.decisionId,
					sourceTitle: params.sourceTitle,
				},
				userId: params.userId,
				organizationId: params.organizationId ?? undefined,
			});
			contextId = created?.id ?? null;
			if (contextId) {
				await setArchitectureDecisionContextId({
					id: params.decisionId,
					contextId,
				});
			}
		}

		if (contextId && params.content.trim().length > 0) {
			await startEmbeddingWorkflow({
				contextId,
				projectId: params.projectId,
				content: params.content,
				sourceTitle: params.sourceTitle,
				userId: params.userId,
				organizationId: params.organizationId,
			});
		}

		return contextId;
	} catch (error) {
		logger.error(
			`[ADL] Failed to sync RAG context for decision ${params.decisionId}: ${error}`,
		);
		return params.contextId;
	}
}

async function startEmbeddingWorkflow(params: {
	contextId: string;
	projectId: string;
	content: string;
	sourceTitle: string;
	userId: string;
	organizationId?: string | null;
}): Promise<void> {
	try {
		const client = await getTemporalClient();
		const workflowId = `context-embedding-${params.contextId}-${Date.now()}`;
		await client.workflow.start(
			"contextEmbeddingWorkflow",
			withCorrelationMemo({
				taskQueue: "project-documents",
				workflowId,
				args: [
					{
						contextId: params.contextId,
						projectId: params.projectId,
						userId: params.userId,
						organizationId: params.organizationId,
						content: params.content,
						type: "ARCHITECTURE_DECISION",
						metadata: { sourceTitle: params.sourceTitle },
					},
				],
			}),
		);
	} catch (error) {
		logger.error(
			`[ADL] Failed to start embedding workflow for context ${params.contextId}: ${error}`,
		);
	}
}

/**
 * Remove the mirrored ProjectContext + its embedding when an ADL is deleted,
 * so a deleted decision stops surfacing to the AI. Uses the durable
 * `contextDeletionWorkflow`; falls back to a direct row delete.
 */
export async function removeArchitectureDecisionContext(params: {
	contextId: string;
	projectId: string;
	userId: string;
	organizationId?: string | null;
}): Promise<void> {
	try {
		const existing = await getContextById(params.contextId);
		if (!existing || existing.projectId !== params.projectId) {
			return;
		}

		const client = await getTemporalClient();
		const workflowId = `context-deletion-${params.contextId}-${Date.now()}`;
		await client.workflow.start(
			"contextDeletionWorkflow",
			withCorrelationMemo({
				taskQueue: "project-documents",
				workflowId,
				args: [
					{
						contextId: params.contextId,
						projectId: params.projectId,
						userId: params.userId,
						organizationId: params.organizationId,
						qdrantId: existing.qdrantId ?? undefined,
						metadata: {
							contextType: "ARCHITECTURE_DECISION",
							contextName:
								existing.sourceTitle ?? "Architecture decision",
							deletedBy: params.userId,
						},
					},
				],
			}),
		);
	} catch (error) {
		logger.error(
			`[ADL] Failed to remove RAG context ${params.contextId}: ${error}`,
		);
		try {
			await deleteContext(params.contextId);
		} catch {
			// already gone — nothing to clean up
		}
	}
}
