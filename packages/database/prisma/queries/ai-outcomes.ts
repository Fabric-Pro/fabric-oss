import { db } from "../client";
import type { AiOutcomeKind } from "../generated/client";

/**
 * Writers and readers for AiOutcomeEvent — one human verdict on one piece of
 * AI-generated output (Fizzy #2230, Phase 2).
 *
 * Tenant scoping follows the XOR pattern: callers pass the organizationId they
 * resolved (null in personal context) and it is stored as-is.
 */

export interface RecordAiOutcomeParams {
	featureKey: string;
	outcome: AiOutcomeKind;
	subjectType: string;
	subjectId: string;
	userId: string;
	organizationId?: string | null;
	projectId?: string | null;
	modelCanonicalName?: string | null;
	promptVersionId?: string | null;
	comment?: string | null;
}

/**
 * Record (or replace) this user's verdict on one piece of AI output.
 *
 * Upsert rather than insert: the unique key is (feature, subject, user), so a
 * user changing their mind updates their single row instead of leaving two
 * contradictory ones. The model/prompt snapshot is refreshed on update because
 * the verdict that counts is the latest one.
 */
export async function recordAiOutcome(params: RecordAiOutcomeParams) {
	const {
		featureKey,
		outcome,
		subjectType,
		subjectId,
		userId,
		organizationId,
		projectId,
		modelCanonicalName,
		promptVersionId,
		comment,
	} = params;

	return db.aiOutcomeEvent.upsert({
		where: {
			featureKey_subjectType_subjectId_userId: {
				featureKey,
				subjectType,
				subjectId,
				userId,
			},
		},
		create: {
			featureKey,
			outcome,
			subjectType,
			subjectId,
			userId,
			organizationId: organizationId ?? null,
			projectId: projectId ?? null,
			modelCanonicalName: modelCanonicalName ?? null,
			promptVersionId: promptVersionId ?? null,
			comment: comment ?? null,
		},
		update: {
			outcome,
			modelCanonicalName: modelCanonicalName ?? null,
			promptVersionId: promptVersionId ?? null,
			comment: comment ?? null,
		},
		select: { id: true, outcome: true, createdAt: true, updatedAt: true },
	});
}

/**
 * Remove this user's verdict — the un-rate half of a toggle. Returns how many
 * rows went away so the caller can tell "cleared" from "there was nothing".
 */
export async function clearAiOutcome(params: {
	featureKey: string;
	subjectType: string;
	subjectId: string;
	userId: string;
}): Promise<number> {
	const result = await db.aiOutcomeEvent.deleteMany({ where: params });
	return result.count;
}

/**
 * This user's own verdicts on a set of subjects, for rendering the control in
 * its current state. Keyed by subjectId.
 */
export async function getAiOutcomesForSubjects(params: {
	featureKey: string;
	subjectType: string;
	subjectIds: string[];
	userId: string;
}): Promise<Record<string, AiOutcomeKind>> {
	if (params.subjectIds.length === 0) {
		return {};
	}
	const rows = await db.aiOutcomeEvent.findMany({
		where: {
			featureKey: params.featureKey,
			subjectType: params.subjectType,
			subjectId: { in: params.subjectIds },
			userId: params.userId,
		},
		select: { subjectId: true, outcome: true },
	});
	return Object.fromEntries(rows.map((row) => [row.subjectId, row.outcome]));
}

export interface AiOutcomeFeatureBreakdown {
	featureKey: string;
	counts: Record<AiOutcomeKind, number>;
	total: number;
}

/**
 * Per-feature outcome counts over a window. One groupBy pass; the caller is
 * responsible for gating this to admins.
 */
export async function getAiOutcomeBreakdown(range: {
	from: Date;
	to: Date;
}): Promise<AiOutcomeFeatureBreakdown[]> {
	const groups = await db.aiOutcomeEvent.groupBy({
		by: ["featureKey", "outcome"],
		where: { createdAt: { gte: range.from, lte: range.to } },
		_count: { _all: true },
	});

	const byFeature = new Map<string, AiOutcomeFeatureBreakdown>();
	for (const group of groups) {
		let entry = byFeature.get(group.featureKey);
		if (!entry) {
			entry = {
				featureKey: group.featureKey,
				counts: {
					ACCEPTED_AS_IS: 0,
					ACCEPTED_WITH_EDITS: 0,
					REJECTED: 0,
					RATED_UP: 0,
					RATED_DOWN: 0,
				},
				total: 0,
			};
			byFeature.set(group.featureKey, entry);
		}
		entry.counts[group.outcome] = group._count._all;
		entry.total += group._count._all;
	}

	return Array.from(byFeature.values()).sort((a, b) => b.total - a.total);
}
