import { db } from "../client";
import { bindPromptVersionToTargets } from "./prompts";

/**
 * Proposing an existing prompt as the default for one or more actions, and the
 * review that follows.
 *
 * Fizzy #2068 FR15-FR18, FR22, FR23.
 */

export type NominationTarget = {
	targetKey: string;
	documentType: string;
	storyKind: "FEATURE" | "BUG" | null;
};

/** Same identity a PromptBinding row carries, so two targets compare cleanly. */
function targetKeyOf(t: NominationTarget): string {
	return `${t.targetKey}::${t.documentType}::${t.storyKind ?? ""}`;
}

/**
 * `targets` is a Json column, so what comes back is `JsonValue` — the database
 * makes no promise about its shape. Check it rather than asserting it: a row
 * written by an older shape would otherwise throw inside the comparison, during
 * an approval, after the binding has already been written.
 */
function parseTargets(value: unknown): NominationTarget[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter(
		(t): t is NominationTarget =>
			typeof t === "object" &&
			t !== null &&
			typeof (t as NominationTarget).targetKey === "string" &&
			typeof (t as NominationTarget).documentType === "string",
	);
}

export async function createPromptNomination({
	promptVersionId,
	nominatedById,
	targetScope,
	organizationId,
	targets,
	changeSummary,
	summaryDegraded,
}: {
	promptVersionId: string;
	nominatedById: string;
	targetScope: "SYSTEM" | "ORG";
	organizationId?: string | null;
	targets: NominationTarget[];
	changeSummary?: string | null;
	summaryDegraded?: boolean;
}) {
	return db.promptNomination.create({
		data: {
			promptVersionId,
			nominatedById,
			targetScope,
			organizationId: organizationId ?? null,
			targets,
			changeSummary: changeSummary ?? null,
			summaryDegraded: summaryDegraded ?? false,
		},
	});
}

/**
 * The reviewer's queue.
 *
 * FR18 wants competing nominations for the same action visible together, so
 * this returns every pending one for the tier and lets the caller group them —
 * grouping in SQL would mean a query per action.
 */
export async function listPendingNominations({
	targetScope,
	organizationId,
}: {
	targetScope: "SYSTEM" | "ORG";
	organizationId?: string | null;
}) {
	return db.promptNomination.findMany({
		where: {
			status: "PENDING",
			targetScope,
			...(targetScope === "ORG"
				? { organizationId: organizationId ?? null }
				: {}),
		},
		orderBy: { createdAt: "asc" },
		include: {
			promptVersion: {
				select: {
					id: true,
					version: true,
					content: true,
					prompt: { select: { id: true, name: true } },
				},
			},
			nominatedBy: { select: { id: true, name: true } },
		},
	});
}

export async function getNominationById(id: string) {
	return db.promptNomination.findUnique({
		where: { id },
		include: {
			promptVersion: {
				select: {
					id: true,
					scope: true,
					content: true,
					prompt: { select: { id: true, name: true } },
				},
			},
		},
	});
}

/**
 * Approve a nomination: bind its prompt at the target tier, then close every
 * other pending nomination competing for the same actions.
 *
 * FR23 — `targets` is what the REVIEWER settled on, which may differ from what
 * the nominator proposed, so it is passed in rather than read from the row.
 *
 * FR18's supersede rule is deliberately scoped to overlapping actions. Closing
 * every pending nomination for the tier would discard proposals about entirely
 * unrelated actions that nobody has reviewed.
 *
 * The status changes run in one transaction: a nomination recorded as approved
 * alongside competitors still showing as pending is a queue that contradicts
 * itself. The binding is written first and outside it — an approval whose
 * binding failed must not record as approved, and Prisma cannot enlist the
 * binding writer's own transaction in this one.
 */
export async function approvePromptNomination({
	nominationId,
	reviewedById,
	targets,
	promptVersionId,
	targetScope,
	organizationId,
}: {
	nominationId: string;
	reviewedById: string;
	targets: NominationTarget[];
	promptVersionId: string;
	targetScope: "SYSTEM" | "ORG";
	organizationId?: string | null;
}) {
	// Claim the nomination BEFORE binding anything.
	//
	// Two admins deciding competing nominations for the same action is the
	// scenario this whole feature is built around, so it is not hypothetical.
	// The PENDING status is the claim: whoever flips it first proceeds, and the
	// loser never writes a binding at all. Reading the status first and then
	// writing — which is what the procedure's own guard does — leaves a window
	// where both readers pass, both bind, and the live default is decided by
	// whichever write happened to land last.
	const { count } = await db.promptNomination.updateMany({
		where: { id: nominationId, status: "PENDING" },
		data: {
			status: "APPROVED",
			reviewedById,
			reviewedAt: new Date(),
			targets,
		},
	});

	if (count === 0) {
		throw new Error("This nomination was already decided");
	}

	try {
		await bindPromptVersionToTargets({
			targets: targets.map((t) => ({
				targetType: "AGENT" as const,
				targetKey: t.targetKey,
				documentType: t.documentType,
				storyKind: t.storyKind,
			})),
			scope: targetScope,
			organizationId: organizationId ?? undefined,
			promptVersionId,
			isDefault: true,
			callerUserId: reviewedById,
		});
	} catch (error) {
		// Hand the claim back. An APPROVED row whose binding never landed is
		// worse than a failed approval: it leaves the queue, so nobody sees
		// that the default was not actually changed.
		await db.promptNomination.updateMany({
			where: { id: nominationId, status: "APPROVED" },
			data: { status: "PENDING", reviewedById: null, reviewedAt: null },
		});
		throw error;
	}

	const approvedKeys = new Set(targets.map(targetKeyOf));

	return db.$transaction(async (tx) => {
		const approved = await tx.promptNomination.findUnique({
			where: { id: nominationId },
		});

		const competing = await tx.promptNomination.findMany({
			where: {
				id: { not: nominationId },
				status: "PENDING",
				targetScope,
				...(targetScope === "ORG"
					? { organizationId: organizationId ?? null }
					: {}),
			},
			select: { id: true, targets: true },
		});

		const supersededIds = competing
			.filter((c) =>
				parseTargets(c.targets).some((t) =>
					approvedKeys.has(targetKeyOf(t)),
				),
			)
			.map((c) => c.id);

		if (supersededIds.length > 0) {
			await tx.promptNomination.updateMany({
				where: { id: { in: supersededIds } },
				data: {
					status: "SUPERSEDED",
					reviewedById,
					reviewedAt: new Date(),
				},
			});
		}

		return { approved, supersededCount: supersededIds.length };
	});
}

/**
 * Decline a nomination.
 *
 * Closed silently by design (FR17): the nominator is not notified and their
 * prompt is untouched. Recorded here so the silence reads as a decision.
 */
export async function declinePromptNomination({
	nominationId,
	reviewedById,
}: {
	nominationId: string;
	reviewedById: string;
}) {
	return db.promptNomination.update({
		where: { id: nominationId },
		data: {
			status: "DECLINED",
			reviewedById,
			reviewedAt: new Date(),
		},
	});
}

/** Withdrawn by the nominator before review. */
export async function withdrawPromptNomination({
	nominationId,
	nominatedById,
}: {
	nominationId: string;
	nominatedById: string;
}) {
	const { count } = await db.promptNomination.updateMany({
		// Scoped to the owner and to PENDING in the same statement: a withdraw
		// cannot reach somebody else's nomination, and cannot reopen a decision
		// that has already been made.
		where: {
			id: nominationId,
			nominatedById,
			status: "PENDING",
		},
		data: { status: "WITHDRAWN" },
	});

	return { withdrawn: count > 0 };
}
