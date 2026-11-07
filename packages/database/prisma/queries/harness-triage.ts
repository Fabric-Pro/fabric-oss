/** Durable private finite jobs. Locks always acquire budget, run, then call. */
import { db, type Prisma } from "../client";

export type { HarnessTriageRun } from "../generated/client";

import {
	createOrganizationContext,
	runWithTenantContext,
} from "../../src/tenant-context";
import { withRLSContext } from "../../src/tenant-db";
import { recordAuditTx } from "./audit-log";
import {
	type DeliverySourceScope,
	requireDeliverySourceStoreAccess,
} from "./delivery-source-capture";

export class HarnessTriageStoreError extends Error {
	constructor(
		readonly code:
			| "NOT_FOUND"
			| "CONFLICT"
			| "BUDGET_UNAVAILABLE"
			| "OUTCOME_UNKNOWN",
	) {
		super("Private triage operation unavailable.");
	}
}
const fail = (code: HarnessTriageStoreError["code"]): never => {
	throw new HarnessTriageStoreError(code);
};
export type TriageScope = DeliverySourceScope;
const where = (s: TriageScope) => ({
	organizationId: s.organizationId,
	projectId: s.projectId,
	userId: s.userId,
});
/** Metadata-only owner context; no decrypted content is returned by its callers. */
function maintenance<T>(
	s: TriageScope,
	work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
	return runWithTenantContext(
		createOrganizationContext(s.organizationId, s.userId),
		() => withRLSContext(db, work, { timeout: 15000 }),
	);
}
export const findHarnessTriageObservation = (s: TriageScope, id: string) =>
	transaction(s, (tx) =>
		tx.deliverySignalObservation.findFirst({ where: { id, ...where(s) } }),
	);
export const countUncertainHarnessTriageCalls = (
	s: TriageScope,
	runId: string,
) =>
	maintenance(s, (tx) =>
		tx.harnessTriageCall.count({
			where: {
				runId,
				...where(s),
				state: { in: ["DISPATCHED", "UNKNOWN"] },
			},
		}),
	);
export const getHarnessTriageFailureMetadata = (
	s: TriageScope,
	id: string,
	workflowId: string,
	nativeRunId: string,
) =>
	maintenance(s, (tx) =>
		tx.harnessTriageRun.findFirst({
			where: {
				id,
				...where(s),
				workflowId,
				OR: [{ nativeRunId: null }, { nativeRunId }],
			},
			select: {
				id: true,
				model: true,
				cancelRequestedAt: true,
				status: true,
			},
		}),
	);
export const failHarnessTriageMetadata = (
	s: TriageScope,
	id: string,
	workflowId: string,
	status: "FAILED" | "CANCELLED" | "OUTCOME_UNKNOWN",
	failureCode: string,
) =>
	maintenance(s, async (tx) => {
		const { row, budget } = await lockLedger(tx, s, id);
		if (
			row.workflowId !== workflowId ||
			!["QUEUED", "RUNNING"].includes(row.status)
		) {
			return;
		}
		await releaseUnsentReservations(tx, s, id, budget.id);
		await tx.harnessTriageRun.updateMany({
			where: {
				id,
				...where(s),
				workflowId,
				status: { in: ["QUEUED", "RUNNING"] },
			},
			data: { status, failureCode },
		});
	});

export async function isHarnessTriageRetentionWorkerQualified(
	connection: Pick<Prisma.TransactionClient, "$queryRaw"> = db,
): Promise<boolean> {
	const rows = await connection.$queryRaw<
		Array<{ allowed: boolean }>
	>`SELECT current_user='fabric_worker' AND (r.rolsuper OR r.rolbypassrls OR 3=(SELECT count(*) FROM pg_policy p WHERE p.polrelid IN (to_regclass('public.harness_triage_run'),to_regclass('public.harness_triage_call'),to_regclass('public.harness_triage_budget')) AND p.polname='worker_bypass' AND p.polcmd='*' AND p.polpermissive AND r.oid=ANY(p.polroles) AND pg_get_expr(p.polqual,p.polrelid)='true' AND pg_get_expr(p.polwithcheck,p.polrelid)='true')) AS allowed FROM pg_roles r WHERE r.rolname=current_user`;
	return rows[0]?.allowed === true;
}
export async function listExpiredHarnessTriageContent() {
	return db.$transaction(async (tx) => {
		if (!(await isHarnessTriageRetentionWorkerQualified(tx))) {
			throw new HarnessTriageStoreError("NOT_FOUND");
		}
		return tx.harnessTriageRun.findMany({
			where: {
				expiresAt: { lte: new Date() },
				OR: [
					{ goalCiphertext: { not: "" } },
					{ resultCiphertext: { not: null } },
					{ reviews: { not: {} } },
					{ calls: { some: { responseCiphertext: { not: null } } } },
				],
			},
			select: {
				id: true,
				organizationId: true,
				projectId: true,
				userId: true,
			},
			take: 500,
			orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
		});
	});
}
function transaction<T>(
	s: TriageScope,
	work: (tx: Prisma.TransactionClient) => Promise<T>,
	write = false,
	network = true,
): Promise<T> {
	if (
		![s.organizationId, s.projectId, s.userId].every(
			(x) => typeof x === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(x),
		)
	) {
		return Promise.reject(new HarnessTriageStoreError("NOT_FOUND"));
	}
	return runWithTenantContext(
		createOrganizationContext(s.organizationId, s.userId),
		() =>
			withRLSContext(
				db,
				async (tx) => {
					await requireDeliverySourceStoreAccess(
						tx,
						s,
						write,
						network,
					);
					return work(tx);
				},
				{ timeout: 15000 },
			),
	);
}
const audit = (
	tx: Prisma.TransactionClient,
	s: TriageScope,
	id: string,
	action: "started" | "cancelled" | "completed" | "reviewed",
) =>
	recordAuditTx(tx, {
		action: `project.triage.${action}`,
		category: "project",
		organizationId: s.organizationId,
		projectId: s.projectId,
		actor: { type: "user", userId: s.userId },
		resource: { type: "harness_triage_run", id },
		metadata: { version: 1 },
	});
export const getHarnessTriageRun = (s: TriageScope, id: string) =>
	transaction(
		s,
		(tx) =>
			tx.harnessTriageRun.findFirst({
				where: { id, ...where(s), expiresAt: { gt: new Date() } },
			}),
		false,
		false,
	);
export const listHarnessTriageRuns = (
	s: TriageScope,
	before?: { createdAt: Date; id: string },
) =>
	transaction(
		s,
		(tx) =>
			tx.harnessTriageRun.findMany({
				where: {
					...where(s),
					expiresAt: { gt: new Date() },
					...(before
						? {
								OR: [
									{ createdAt: { lt: before.createdAt } },
									{
										createdAt: before.createdAt,
										id: { lt: before.id },
									},
								],
							}
						: {}),
				},
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
				take: 21,
			}),
		false,
		false,
	);
export const findHarnessTriageRequest = (s: TriageScope, requestId: string) =>
	transaction(s, (tx) =>
		tx.harnessTriageRun.findFirst({ where: { requestId, ...where(s) } }),
	);
export async function admitHarnessTriageRun(
	s: TriageScope,
	data: Omit<
		Prisma.HarnessTriageRunUncheckedCreateInput,
		"organizationId" | "projectId" | "userId" | "calls"
	>,
) {
	return transaction(
		s,
		async (tx) => {
			const previous = await tx.harnessTriageRun.findFirst({
				where: {
					organizationId: s.organizationId,
					userId: s.userId,
					requestId: data.requestId,
				},
			});
			if (previous) {
				if (
					previous.projectId !== s.projectId ||
					previous.inputHash !== data.inputHash
				) {
					fail("CONFLICT");
				}
				return previous;
			}
			const inserted = await tx.harnessTriageRun.createMany({
				data: [{ ...data, ...where(s) }],
				skipDuplicates: true,
			});
			const row = await tx.harnessTriageRun.findFirst({
				where: {
					organizationId: s.organizationId,
					userId: s.userId,
					requestId: data.requestId,
				},
			});
			if (
				!row ||
				row.projectId !== s.projectId ||
				row.inputHash !== data.inputHash
			) {
				return fail("CONFLICT");
			}
			if (inserted.count === 1) {
				await audit(tx, s, row.id, "started");
			}
			return row;
		},
		true,
	);
}
async function lockRun(
	tx: Prisma.TransactionClient,
	s: TriageScope,
	id: string,
) {
	await tx.$queryRaw`SELECT "id" FROM "harness_triage_run" WHERE "id"=${id} AND "organizationId"=${s.organizationId} AND "projectId"=${s.projectId} AND "userId"=${s.userId} FOR UPDATE`;
	const row = await tx.harnessTriageRun.findFirst({
		where: { id, ...where(s) },
	});
	if (!row) {
		return fail("NOT_FOUND");
	}
	return row;
}
export async function markHarnessTriageNativeRun(
	s: TriageScope,
	id: string,
	nativeRunId: string,
) {
	return transaction(s, async (tx) => {
		const row = await lockRun(tx, s, id);
		if (row.nativeRunId && row.nativeRunId !== nativeRunId) {
			return fail("CONFLICT");
		}
		return tx.harnessTriageRun.update({
			where: { id: row.id },
			data: { nativeRunId },
		});
	});
}
export async function cancelHarnessTriageRun(s: TriageScope, id: string) {
	return transaction(
		s,
		async (tx) => {
			const { row, budget } = await lockLedger(tx, s, id);
			if (!["QUEUED", "RUNNING"].includes(row.status)) {
				return;
			}
			await releaseUnsentReservations(tx, s, id, budget.id);
			if (!row.cancelRequestedAt) {
				const uncertain = await tx.harnessTriageCall.count({
					where: {
						runId: id,
						...where(s),
						state: { in: ["DISPATCHED", "UNKNOWN"] },
					},
				});
				await tx.harnessTriageRun.update({
					where: { id: row.id },
					data: {
						cancelRequestedAt: new Date(),
						failureCode: uncertain
							? "OUTCOME_UNKNOWN"
							: "CANCELLED",
						status: ["QUEUED", "RUNNING"].includes(row.status)
							? "CANCELLED"
							: row.status,
					},
				});
				await audit(tx, s, id, "cancelled");
			}
		},
		true,
		false,
	);
}
export async function finishHarnessTriageRun(
	s: TriageScope,
	id: string,
	status:
		| "RUNNING"
		| "COMPLETED"
		| "FAILED"
		| "OUTCOME_UNKNOWN"
		| "CANCELLED",
	resultCiphertext?: string,
	failureCode?: string,
) {
	return transaction(s, async (tx) => {
		const { row, budget } = await lockLedger(tx, s, id);
		if (
			["COMPLETED", "FAILED", "OUTCOME_UNKNOWN", "CANCELLED"].includes(
				row.status,
			)
		) {
			return;
		}
		const expired = row.expiresAt <= new Date();
		const stopped = row.cancelRequestedAt || expired;
		if (stopped || status !== "RUNNING") {
			await releaseUnsentReservations(tx, s, id, budget.id);
		}
		await tx.harnessTriageRun.update({
			where: { id: row.id },
			data: {
				status: stopped ? "CANCELLED" : status,
				resultCiphertext:
					!stopped && status === "COMPLETED"
						? (resultCiphertext ?? null)
						: null,
				failureCode: failureCode ?? null,
			},
		});
		if (status === "COMPLETED" && !stopped) {
			await audit(tx, s, id, "completed");
		}
	});
}
export async function reviewHarnessTriageProposal(
	s: TriageScope,
	id: string,
	proposalId: string,
	decision: "KEEP" | "DISMISS",
) {
	return transaction(
		s,
		async (tx) => {
			const row = await lockRun(tx, s, id);
			if (row.status !== "COMPLETED" || row.expiresAt <= new Date()) {
				return fail("CONFLICT");
			}
			const reviews =
				typeof row.reviews === "object" &&
				!Array.isArray(row.reviews) &&
				row.reviews
					? row.reviews
					: {};
			await tx.harnessTriageRun.update({
				where: { id: row.id },
				data: { reviews: { ...reviews, [proposalId]: decision } },
			});
			await audit(tx, s, id, "reviewed");
		},
		true,
	);
}
export interface TriageReservation {
	callId: string;
	runId: string;
	ordinal: number;
	requestDigest: string;
	reservedTokens: number;
	reservedMicroUsd: number;
	monthlyTokens: number;
	monthlyMicroUsd: number;
}
async function lockLedger(
	tx: Prisma.TransactionClient,
	s: TriageScope,
	id: string,
) {
	// Immutable period binding read under tenant scope, then global lock ordering.
	const found = await tx.harnessTriageRun.findFirst({
		where: { id, ...where(s) },
	});
	if (!found) {
		return fail("NOT_FOUND");
	}
	const budgetId = `${s.organizationId}:${found.periodStart.toISOString().slice(0, 7)}`;
	await tx.harnessTriageBudget.createMany({
		data: [
			{
				id: budgetId,
				organizationId: s.organizationId,
				periodStart: found.periodStart,
			},
		],
		skipDuplicates: true,
	});
	await tx.$queryRaw`SELECT "id" FROM "harness_triage_budget" WHERE "id"=${budgetId} AND "organizationId"=${s.organizationId} FOR UPDATE`;
	const row = await lockRun(tx, s, id);
	const budget = await tx.harnessTriageBudget.findUniqueOrThrow({
		where: { id: budgetId },
	});
	return { row, budget };
}
async function releaseUnsentReservations(
	tx: Prisma.TransactionClient,
	s: TriageScope,
	id: string,
	budgetId: string,
) {
	const calls = await tx.harnessTriageCall.findMany({
		where: { runId: id, ...where(s), state: "RESERVED" },
		select: { reservedTokens: true, reservedMicroUsd: true },
	});
	if (!calls.length) {
		return;
	}
	const tokens = calls.reduce((sum, c) => sum + c.reservedTokens, BigInt(0));
	const microUsd = calls.reduce(
		(sum, c) => sum + c.reservedMicroUsd,
		BigInt(0),
	);
	await tx.harnessTriageCall.updateMany({
		where: { runId: id, ...where(s), state: "RESERVED" },
		data: { state: "RELEASED", responseCiphertext: null },
	});
	const data = {
		outstandingTokens: { decrement: tokens },
		outstandingMicroUsd: { decrement: microUsd },
	};
	await tx.harnessTriageRun.update({ where: { id }, data });
	await tx.harnessTriageBudget.update({ where: { id: budgetId }, data });
}
export async function reserveHarnessTriageCall(
	s: TriageScope,
	input: TriageReservation,
) {
	return transaction(s, async (tx) => {
		const { row, budget } = await lockLedger(tx, s, input.runId);
		if (
			row.cancelRequestedAt ||
			row.expiresAt <= new Date() ||
			!["QUEUED", "RUNNING"].includes(row.status)
		) {
			return null;
		}
		if (
			!Number.isSafeInteger(input.ordinal) ||
			input.ordinal < 1 ||
			input.ordinal > 6 ||
			input.callId !== `${row.id}:model:${input.ordinal}` ||
			!/^[a-f0-9]{64}$/.test(input.requestDigest) ||
			![
				input.reservedTokens,
				input.reservedMicroUsd,
				input.monthlyTokens,
				input.monthlyMicroUsd,
			].every((x) => Number.isSafeInteger(x) && x > 0)
		) {
			return fail("BUDGET_UNAVAILABLE");
		}
		const previous = await tx.harnessTriageCall.findFirst({
			where: { id: input.callId, runId: row.id, ...where(s) },
		});
		if (previous) {
			if (previous.requestDigest !== input.requestDigest) {
				return fail("CONFLICT");
			}
			return previous.state === "SETTLED" && previous.responseCiphertext
				? { dispatch: "REPLAY" as const, call: previous }
				: null;
		}
		if (
			row.periodStart.toISOString().slice(0, 7) !==
			new Date().toISOString().slice(0, 7)
		) {
			return null;
		}
		const tokens = BigInt(input.reservedTokens);
		const cost = BigInt(input.reservedMicroUsd);
		if (
			row.measuredTokens + row.outstandingTokens + tokens >
				row.maxTokens ||
			row.measuredMicroUsd + row.outstandingMicroUsd + cost >
				row.maxMicroUsd ||
			budget.measuredTokens + budget.outstandingTokens + tokens >
				BigInt(input.monthlyTokens) ||
			budget.measuredMicroUsd + budget.outstandingMicroUsd + cost >
				BigInt(input.monthlyMicroUsd)
		) {
			return null;
		}
		const call = await tx.harnessTriageCall.create({
			data: {
				id: input.callId,
				runId: row.id,
				...where(s),
				ordinal: input.ordinal,
				requestDigest: input.requestDigest,
				reservedTokens: tokens,
				reservedMicroUsd: cost,
				expiresAt: row.expiresAt,
			},
		});
		const data = {
			outstandingTokens: { increment: tokens },
			outstandingMicroUsd: { increment: cost },
		};
		await tx.harnessTriageRun.update({ where: { id: row.id }, data });
		await tx.harnessTriageBudget.update({ where: { id: budget.id }, data });
		return { dispatch: "SEND_ONCE" as const, call };
	});
}
export async function dispatchHarnessTriageCall(
	s: TriageScope,
	id: string,
	callId: string,
	digest: string,
) {
	return transaction(s, async (tx) => {
		const { row } = await lockLedger(tx, s, id);
		if (
			row.cancelRequestedAt ||
			row.expiresAt <= new Date() ||
			!["QUEUED", "RUNNING"].includes(row.status)
		) {
			return false;
		}
		return (
			(
				await tx.harnessTriageCall.updateMany({
					where: {
						id: callId,
						runId: id,
						...where(s),
						requestDigest: digest,
						state: "RESERVED",
					},
					data: { state: "DISPATCHED" },
				})
			).count === 1
		);
	});
}
export async function recordHarnessTriageResponse(
	s: TriageScope,
	id: string,
	callId: string,
	responseCiphertext: string,
) {
	return transaction(s, async (tx) => {
		const { row } = await lockLedger(tx, s, id);
		if (
			row.cancelRequestedAt ||
			row.expiresAt <= new Date() ||
			row.status !== "RUNNING"
		) {
			return;
		}
		await tx.harnessTriageCall.updateMany({
			where: {
				id: callId,
				runId: id,
				...where(s),
				state: "DISPATCHED",
				expiresAt: { gt: new Date() },
			},
			data: { responseCiphertext },
		});
	});
}
export async function transitionHarnessTriageCall(
	s: TriageScope,
	id: string,
	callId: string,
	state: "RELEASED" | "SETTLED" | "UNKNOWN",
	usage?: { tokens: number; microUsd: number },
) {
	return transaction(s, async (tx) => {
		const { row, budget } = await lockLedger(tx, s, id);
		const call = await tx.harnessTriageCall.findFirst({
			where: { id: callId, runId: id, ...where(s) },
		});
		if (!call) {
			return fail("NOT_FOUND");
		}
		// Terminal writes never downgrade a settlement, including after lost acknowledgements.
		if (["SETTLED", "UNKNOWN", "RELEASED"].includes(call.state)) {
			return;
		}
		if (state === "RELEASED" && call.state !== "RESERVED") {
			return fail("OUTCOME_UNKNOWN");
		}
		if (
			state === "SETTLED" &&
			(!usage ||
				!call.responseCiphertext ||
				call.state !== "DISPATCHED" ||
				![usage.tokens, usage.microUsd].every(
					(x) => Number.isSafeInteger(x) && x >= 0,
				))
		) {
			return fail("BUDGET_UNAVAILABLE");
		}
		if (
			state === "SETTLED" &&
			usage &&
			(BigInt(usage.tokens) > call.reservedTokens ||
				BigInt(usage.microUsd) > call.reservedMicroUsd)
		) {
			return fail("BUDGET_UNAVAILABLE");
		}
		const tokens = BigInt(usage?.tokens ?? 0);
		const cost = BigInt(usage?.microUsd ?? 0);
		await tx.harnessTriageCall.update({
			where: { id: call.id },
			data: {
				state,
				...(state === "SETTLED"
					? { measuredTokens: tokens, measuredMicroUsd: cost }
					: { responseCiphertext: null }),
			},
		});
		if (state !== "UNKNOWN") {
			const data = {
				outstandingTokens: { decrement: call.reservedTokens },
				outstandingMicroUsd: { decrement: call.reservedMicroUsd },
				...(state === "SETTLED"
					? {
							measuredTokens: { increment: tokens },
							measuredMicroUsd: { increment: cost },
						}
					: {}),
			};
			await tx.harnessTriageRun.update({ where: { id: row.id }, data });
			await tx.harnessTriageBudget.update({
				where: { id: budget.id },
				data,
			});
		}
	});
}
/** Expiry deletes content, retaining only identity/accounting for retry fencing. */
export async function purgeExpiredHarnessTriageContent(
	s: TriageScope,
	id: string,
) {
	// Retention is permitted after actor/source revocation; it can only remove content.
	return maintenance(s, async (tx) => {
		const row = await lockRun(tx, s, id);
		if (row.expiresAt > new Date()) {
			return;
		}
		await tx.harnessTriageRun.update({
			where: { id: row.id },
			data: { goalCiphertext: "", resultCiphertext: null, reviews: {} },
		});
		await tx.harnessTriageCall.updateMany({
			where: { runId: row.id, ...where(s) },
			data: { responseCiphertext: null },
		});
	});
}
