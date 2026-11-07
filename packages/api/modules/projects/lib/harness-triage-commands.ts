/** Canonical product operations: every transport supplies authenticated facts here. */
import { createHash, randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import {
	admitHarnessTriageRun,
	cancelHarnessTriageRun,
	canEditProject,
	countUncertainHarnessTriageCalls,
	db,
	failHarnessTriageMetadata,
	findHarnessTriageObservation,
	findHarnessTriageRequest,
	getHarnessTriageRun,
	getOwnedDeliverySourceObservation,
	getOwnedDeliverySourceWatch,
	type HarnessTriageRun,
	listHarnessTriageRuns,
	markHarnessTriageNativeRun,
	reviewHarnessTriageProposal,
	type TriageScope,
} from "@repo/database";
import {
	hasPermission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
import { getTemporalClient } from "@repo/temporal/client";
import { decryptApiKey, encryptApiKey } from "@repo/utils";
import { parseOAuthReference } from "@repo/utils/oauth-project-resource";
import { z } from "zod";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	type DeliverySignalActor,
	deliverySignalPermissionDenied,
	requireDeliverySignalProjectAccess,
} from "./delivery-signals";
import {
	requirePrivateDeliverySourceEvidenceAccess,
	requirePrivateDeliverySourceProject,
} from "./delivery-source-commands";
import {
	type TriageCredential,
	type TriageOperation,
	triageCredential,
	triageList,
	triageListInput,
	triagePin,
	triageRequiredScopes,
	triageResult,
	triageReviewInput,
	triageRun,
	triageRunDetail,
	triageRunInput,
	triageStartInput,
} from "./harness-triage-contracts";
import { createPrivateTriageEvidenceReader } from "./harness-triage-evidence";
import {
	resolveTriageExecutionBinding,
	triageStoredModel,
} from "./harness-triage-native";
export const TRIAGE_QUEUE = "fabric-harness-triage-v1";
export interface TriageActor extends DeliverySignalActor {
	credential: TriageCredential;
}
export const triageScopeError = () =>
	new ORPCError("FORBIDDEN", {
		message: "Required triage scopes are missing.",
		data: { code: "INSUFFICIENT_SCOPE" },
	});
export function requireTriageScopes(
	credential: TriageCredential,
	operation: TriageOperation,
) {
	if (
		credential.kind !== "SESSION" &&
		triageRequiredScopes(operation).some(
			(s) =>
				!credential.scopes.includes(s) &&
				!credential.scopes.includes("*"),
		)
	) {
		throw triageScopeError();
	}
}
export async function checkTriageCredential(
	scope: TriageScope,
	raw: TriageCredential,
	operation: TriageOperation,
) {
	const credential = triageCredential.parse(raw);
	requireTriageScopes(credential, operation);
	if (credential.kind === "SESSION") {
		return;
	}
	let scopes: string[] | undefined;
	if (credential.kind === "USER_API_KEY") {
		const key = await db.userApiKey.findFirst({
			where: {
				id: credential.id,
				userId: scope.userId,
				isActive: true,
				OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
			},
			select: { scopes: true },
		});
		scopes = key?.scopes;
	} else if (credential.kind === "ORGANIZATION_API_KEY") {
		const key = await db.organizationApiKey.findFirst({
			where: {
				id: credential.id,
				organizationId: scope.organizationId,
				createdByUserId: scope.userId,
				isActive: true,
				OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
			},
			select: { scopes: true },
		});
		scopes = key?.scopes;
	} else if (credential.kind === "OAUTH_CLIENT") {
		const reference = parseOAuthReference(credential.referenceId);
		if (
			!reference ||
			(reference.kind === "organization"
				? reference.organizationId !== scope.organizationId
				: reference.projectId !== scope.projectId)
		) {
			deliverySignalPermissionDenied();
		}
		const client = await db.oauthClient.findFirst({
			where: { id: credential.id, disabled: false },
			select: { clientId: true, skipConsent: true },
		});
		if (client) {
			const grant = {
				clientId: client.clientId,
				userId: scope.userId,
				referenceId: credential.referenceId,
			};
			const [consent, access, refresh] = await Promise.all([
				db.oauthConsent.findFirst({
					where: grant,
					select: { scopes: true },
				}),
				db.oauthAccessToken.findFirst({
					where: {
						...grant,
						revoked: null,
						expiresAt: { gt: new Date() },
					},
					select: { id: true, scopes: true },
				}),
				db.oauthRefreshToken.findFirst({
					where: {
						...grant,
						revoked: null,
						expiresAt: { gt: new Date() },
					},
					select: { id: true, scopes: true },
				}),
			]);
			const tokenScopes = (access ?? refresh)?.scopes;
			if (tokenScopes) {
				const allowed =
					consent?.scopes ??
					(client.skipConsent ? tokenScopes : undefined);
				if (allowed) {
					scopes = allowed.includes("*")
						? tokenScopes
						: tokenScopes.includes("*")
							? allowed
							: allowed.filter((scope) =>
									tokenScopes.includes(scope),
								);
				}
			}
		}
	}
	if (!scopes) {
		deliverySignalPermissionDenied();
	}
	requireTriageScopes({ ...credential, scopes }, operation);
}
export async function authorizeTriage(
	actor: TriageActor,
	projectId: string,
	operation: TriageOperation,
) {
	requireTriageScopes(triageCredential.parse(actor.credential), operation);
	const scope = await requireDeliverySignalProjectAccess(actor, projectId);
	await checkTriageCredential(scope, actor.credential, operation);
	if (["start", "result", "review"].includes(operation)) {
		await requirePrivateDeliverySourceEvidenceAccess(actor, projectId);
	} else {
		await requirePrivateDeliverySourceProject(actor, projectId, false);
	}
	if (
		["start", "cancel", "review"].includes(operation) &&
		!(await canEditProject(projectId, actor.userId))
	) {
		deliverySignalPermissionDenied();
	}
	if (["start", "cancel", "review"].includes(operation)) {
		await requirePrivateDeliverySourceProject(actor, projectId, true);
	}
	if (operation === "start") {
		const member = await db.member.findUnique({
			where: {
				organizationId_userId: {
					organizationId: scope.organizationId,
					userId: scope.userId,
				},
			},
			select: { role: true },
		});
		if (
			!member ||
			!hasPermission(
				resolveOrgPermissions(member.role),
				Permissions.AI_MODEL_RESOLVE,
			)
		) {
			deliverySignalPermissionDenied();
		}
	}
	return scope;
}
export function triageLimits() {
	const monthlyMicroUsd = Number(
		process.env.FABRIC_HARNESS_TRIAGE_MONTHLY_MICRO_USD,
	);
	if (
		process.env.FABRIC_HARNESS_TRIAGE_ENABLED !== "true" ||
		!Number.isSafeInteger(monthlyMicroUsd) ||
		monthlyMicroUsd < 1 ||
		monthlyMicroUsd > 100_000_000
	) {
		return null;
	}
	return {
		monthlyMicroUsd,
		monthlyTokens: 2_000_000,
		maxMicroUsd: Math.min(monthlyMicroUsd, 250_000),
		maxTokens: 196608,
	};
}
export function projectTriageRun(row: HarnessTriageRun) {
	const pins = z.array(triagePin).min(1).max(5).parse(row.evidence);
	return triageRun.parse({
		id: row.id,
		status: row.status,
		createdAt: row.createdAt.toISOString(),
		expiresAt: row.expiresAt.toISOString(),
		selectedCount: pins.length,
		failureCode: row.failureCode,
	});
}
export async function assertTriagePins(scope: TriageScope, raw: unknown) {
	const pins = z.array(triagePin).min(1).max(5).parse(raw);
	for (const pin of pins) {
		const [observation, watch] = await Promise.all([
			getOwnedDeliverySourceObservation(scope, {
				watchId: pin.watchId,
				observationId: pin.observationId,
			}),
			getOwnedDeliverySourceWatch(scope, pin.watchId),
		]);
		if (
			!observation ||
			!watch ||
			observation.hasConflict ||
			observation.expiresAt <= new Date() ||
			observation.grantId !== pin.grantId ||
			observation.evidenceDigest !== pin.evidenceDigest ||
			watch.grantRevision !== pin.grantRevision
		) {
			throw new ORPCError("FORBIDDEN", {
				message: "Selected evidence is no longer available.",
				data: { code: "EVIDENCE_UNAVAILABLE" },
			});
		}
	}
	return pins;
}
async function owned(
	actor: TriageActor,
	raw: unknown,
	operation: TriageOperation,
) {
	const input = triageRunInput.parse(raw);
	const scope = await authorizeTriage(actor, input.projectId, operation);
	const row = await getHarnessTriageRun(scope, input.runId);
	if (!row) {
		throw new ORPCError("NOT_FOUND");
	}
	// Revocation fences derived content; current owner rights still allow stopping
	// work and reading content-free status after the original grant is revoked.
	if (operation === "result" || operation === "review") {
		await checkTriageCredential(
			scope,
			triageCredential.parse(row.credential),
			"start",
		);
	}
	return { input, scope, row };
}
function triageCursor(scope: TriageScope, value?: string) {
	if (!value) {
		return undefined;
	}
	try {
		const token = z
			.strictObject({
				version: z.literal(1),
				organizationId: z.string(),
				projectId: z.string(),
				userId: z.string(),
				createdAt: z.iso.datetime(),
				id: z.string().min(1).max(200),
			})
			.parse(
				JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
			);
		if (
			token.organizationId !== scope.organizationId ||
			token.projectId !== scope.projectId ||
			token.userId !== scope.userId
		) {
			throw new ORPCError("NOT_FOUND");
		}
		return { createdAt: new Date(token.createdAt), id: token.id };
	} catch (error) {
		if (error instanceof ORPCError) {
			throw error;
		}
		throw new ORPCError("BAD_REQUEST", {
			message: "Invalid private review continuation.",
		});
	}
}
export async function listPrivateTriageRuns(actor: TriageActor, raw: unknown) {
	const input = triageListInput.parse(raw);
	const scope = await authorizeTriage(actor, input.projectId, "list");
	try {
		const rows = await listHarnessTriageRuns(
			scope,
			triageCursor(scope, input.before),
		);
		return triageList.parse({
			version: 1,
			availability: triageLimits() ? "AVAILABLE" : "NOT_ENABLED",
			runs: rows.slice(0, 20).map(projectTriageRun),
			nextBefore:
				rows.length > 20
					? Buffer.from(
							JSON.stringify({
								version: 1,
								...scope,
								createdAt: rows[19].createdAt.toISOString(),
								id: rows[19].id,
							}),
						).toString("base64url")
					: null,
		});
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			["P2021", "P2022"].includes(String(error.code))
		) {
			return triageList.parse({
				version: 1,
				availability: "STORAGE_UNAVAILABLE",
				runs: [],
				nextBefore: null,
			});
		}
		throw error;
	}
}
export async function startPrivateTriage(actor: TriageActor, raw: unknown) {
	const input = triageStartInput.parse(raw);
	const scope = await authorizeTriage(actor, input.projectId, "start");
	const limits = triageLimits();
	if (!limits) {
		throw new ORPCError("SERVICE_UNAVAILABLE", {
			message: "Signal review is not enabled in this environment.",
			data: { code: "TRIAGE_NOT_ENABLED" },
		});
	}
	const payload = {
		goal: input.goal,
		evidenceIds: [...input.evidenceIds].sort(),
	};
	const client = await getTemporalClient();
	const execution = await resolveTriageExecutionBinding(client);
	const inputHash = createHash("sha256")
		.update(JSON.stringify([1, payload.goal, payload.evidenceIds]))
		.digest("hex");
	let row = await findHarnessTriageRequest(scope, input.requestId);
	if (row && row.inputHash !== inputHash) {
		throw new ORPCError("CONFLICT", {
			message: "Request ID belongs to different input.",
		});
	}
	if (!row) {
		const pins = [];
		let expiresAt = new Date(Date.now() + 7 * 86400000);
		for (const observationId of payload.evidenceIds) {
			// An observation id is never accepted as authority: resolve the owner-bound original source.
			const observation = await findHarnessTriageObservation(
				scope,
				observationId,
			);
			if (!observation) {
				throw new ORPCError("NOT_FOUND");
			}
			const watch = await getOwnedDeliverySourceWatch(
				scope,
				observation.watchId,
			);
			if (!watch) {
				throw new ORPCError("NOT_FOUND");
			}
			pins.push({
				observationId: observation.id,
				watchId: watch.id,
				grantId: observation.grantId,
				grantRevision: watch.grantRevision,
				evidenceDigest: observation.evidenceDigest,
			});
			expiresAt = new Date(
				Math.min(expiresAt.getTime(), observation.expiresAt.getTime()),
			);
		}
		await assertTriagePins(scope, pins);
		const { resolveTriageModel } = await import("./harness-triage-model");
		const { pin: model } = await resolveTriageModel(scope);
		const id = randomUUID();
		const workflowId =
			"harness-triage-" +
			createHash("sha256")
				.update(
					JSON.stringify([
						scope.organizationId,
						scope.userId,
						scope.projectId,
						input.requestId,
						execution.routingDigest,
					]),
				)
				.digest("hex");
		row = await admitHarnessTriageRun(scope, {
			id,
			requestId: input.requestId,
			inputHash,
			goalCiphertext: encryptApiKey(payload.goal),
			evidence: pins,
			credential: actor.credential,
			model: { pin: model, execution },
			workflowId,
			periodStart: new Date(
				Date.UTC(
					new Date().getUTCFullYear(),
					new Date().getUTCMonth(),
					1,
				),
			),
			expiresAt,
			maxTokens: limits.maxTokens,
			maxMicroUsd: BigInt(limits.maxMicroUsd),
		});
	}
	await checkTriageCredential(
		scope,
		triageCredential.parse(row.credential),
		"start",
	);
	await assertTriagePins(scope, row.evidence);
	const stored = triageStoredModel.parse(row.model);
	if (stored.execution.routingDigest !== execution.routingDigest) {
		throw new ORPCError("CONFLICT", {
			message: "This run belongs to a different execution binding.",
		});
	}
	if (
		row.cancelRequestedAt ||
		row.expiresAt <= new Date() ||
		["COMPLETED", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"].includes(
			row.status,
		)
	) {
		return projectTriageRun(row);
	}
	try {
		const handle = await client.workflow.start(
			"harnessSignalTriageWorkflow",
			withCorrelationMemo({
				workflowId: row.workflowId,
				taskQueue: TRIAGE_QUEUE,
				args: [
					{
						runId: row.id,
						...scope,
						expiresAt: row.expiresAt.toISOString(),
					},
				],
				workflowIdReusePolicy: "REJECT_DUPLICATE",
				workflowExecutionTimeout: "8 days",
				memo: {
					fabricHarnessTriage: {
						version: 1,
						runId: row.id,
						...scope,
						routingDigest: execution.routingDigest,
					},
				},
			}),
		);
		await markHarnessTriageNativeRun(
			scope,
			row.id,
			handle.firstExecutionRunId,
		);
	} catch (error) {
		if (
			!(error instanceof Error) ||
			error.name !== "WorkflowExecutionAlreadyStartedError"
		) {
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message:
					"Run admission is saved. Retry the same request ID to reconnect.",
				data: { code: "OUTCOME_UNKNOWN" },
			});
		}
		const description = await client.workflow
			.getHandle(row.workflowId)
			.describe();
		const memo = description.memo?.fabricHarnessTriage;
		if (
			description.type !== "harnessSignalTriageWorkflow" ||
			description.taskQueue !== TRIAGE_QUEUE ||
			!memo ||
			typeof memo !== "object" ||
			Object.entries({
				version: 1,
				runId: row.id,
				...scope,
				routingDigest: execution.routingDigest,
			}).some(
				([key, value]) =>
					(memo as Record<string, unknown>)[key] !== value,
			)
		) {
			throw new ORPCError("CONFLICT", {
				message: "Native run identity could not be verified.",
			});
		}
		await markHarnessTriageNativeRun(scope, row.id, description.runId);
	}
	return projectTriageRun((await getHarnessTriageRun(scope, row.id)) ?? row);
}
export async function getPrivateTriageStatus(actor: TriageActor, raw: unknown) {
	const { row, scope } = await owned(actor, raw, "status");
	if (["QUEUED", "RUNNING"].includes(row.status) && row.nativeRunId) {
		const client = await getTemporalClient();
		const current = await resolveTriageExecutionBinding(client);
		if (
			current.routingDigest !==
			triageStoredModel.parse(row.model).execution.routingDigest
		) {
			throw new ORPCError("CONFLICT");
		}
		try {
			const description = await client.connection.withDeadline(
				Date.now() + 5000,
				() =>
					client.workflow
						.getHandle(row.workflowId, row.nativeRunId!)
						.describe(),
			);
			if (
				[
					"FAILED",
					"CANCELLED",
					"TIMED_OUT",
					"TERMINATED",
					"COMPLETED",
				].includes(description.status.name)
			) {
				const uncertain = await countUncertainHarnessTriageCalls(
					scope,
					row.id,
				);
				await failHarnessTriageMetadata(
					scope,
					row.id,
					row.workflowId,
					uncertain
						? "OUTCOME_UNKNOWN"
						: description.status.name === "CANCELLED"
							? "CANCELLED"
							: "FAILED",
					uncertain
						? "OUTCOME_UNKNOWN"
						: description.status.name === "CANCELLED"
							? "CANCELLED"
							: "MODEL_UNAVAILABLE",
				);
				return projectTriageRun(
					(await getHarnessTriageRun(scope, row.id)) ?? row,
				);
			}
		} catch (error) {
			if (
				!(error instanceof Error) ||
				error.name !== "WorkflowNotFoundError"
			) {
				throw error;
			}
			const uncertain = await countUncertainHarnessTriageCalls(
				scope,
				row.id,
			);
			await failHarnessTriageMetadata(
				scope,
				row.id,
				row.workflowId,
				uncertain ? "OUTCOME_UNKNOWN" : "FAILED",
				uncertain ? "OUTCOME_UNKNOWN" : "MODEL_UNAVAILABLE",
			);
			return projectTriageRun(
				(await getHarnessTriageRun(scope, row.id)) ?? row,
			);
		}
	}
	if (
		row.status === "CANCELLED" &&
		row.failureCode !== "OUTCOME_UNKNOWN" &&
		(await countUncertainHarnessTriageCalls(scope, row.id))
	)
		return projectTriageRun({ ...row, failureCode: "OUTCOME_UNKNOWN" });
	return projectTriageRun(row);
}
export async function getPrivateTriageResult(actor: TriageActor, raw: unknown) {
	const { row, scope } = await owned(actor, raw, "result");
	const pins = await assertTriagePins(scope, row.evidence);
	let result: null | z.infer<typeof triageResult> = null;
	if (row.status === "COMPLETED" && row.resultCiphertext) {
		const read = await createPrivateTriageEvidenceReader(
			actor,
			scope.projectId,
			actor.credential.kind === "SESSION"
				? { kind: "SESSION" }
				: { kind: "API_KEY", scopes: actor.credential.scopes },
		);
		const authority = {
			runId: row.id,
			organizationId: scope.organizationId,
			projectId: scope.projectId,
			actorId: scope.userId,
			inputHash: row.inputHash,
			evidence: pins,
			model: { id: "private-review", maxOutputTokens: 1 },
		};
		const signal = AbortSignal.timeout(30000);
		for (const pin of pins) {
			await read(authority, pin, signal);
		}
		await authorizeTriage(actor, scope.projectId, "result");
		await assertTriagePins(scope, pins);
		result = triageResult.parse(
			JSON.parse(decryptApiKey(row.resultCiphertext)),
		);
		if (JSON.stringify(result.reviewedEvidence) !== JSON.stringify(pins)) {
			throw new ORPCError("CONFLICT");
		}
	}
	return triageRunDetail.parse({
		version: 1,
		run: projectTriageRun(row),
		result,
		reviews: row.reviews,
	});
}
export async function cancelPrivateTriage(actor: TriageActor, raw: unknown) {
	const { row, scope } = await owned(actor, raw, "cancel");
	if (
		["COMPLETED", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"].includes(
			row.status,
		)
	) {
		return projectTriageRun(row);
	}
	await cancelHarnessTriageRun(scope, row.id);
	if (!row.nativeRunId) {
		return getPrivateTriageStatus(actor, raw);
	}
	const client = await getTemporalClient();
	try {
		const binding = triageStoredModel.parse(row.model).execution;
		const current = await resolveTriageExecutionBinding(client);
		if (
			current.routingDigest !== binding.routingDigest ||
			!row.nativeRunId
		) {
			throw new ORPCError("CONFLICT", {
				message: "Native cancellation identity is unconfirmed.",
			});
		}
		await client.workflow
			.getHandle(row.workflowId, row.nativeRunId)
			.cancel();
	} catch (error) {
		if (
			!(error instanceof Error) ||
			error.name !== "WorkflowNotFoundError"
		) {
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message:
					"Cancellation is saved; native acknowledgement is pending.",
				data: { code: "OUTCOME_UNKNOWN" },
			});
		}
	}
	return getPrivateTriageStatus(actor, raw);
}
export async function reviewPrivateTriage(actor: TriageActor, raw: unknown) {
	const input = triageReviewInput.parse(raw);
	await authorizeTriage(actor, input.projectId, "review");
	const detail = await getPrivateTriageResult(actor, {
		projectId: input.projectId,
		runId: input.runId,
	});
	if (!detail.result?.proposals.some((p) => p.id === input.proposalId)) {
		throw new ORPCError("NOT_FOUND");
	}
	const { scope } = await owned(
		actor,
		{ projectId: input.projectId, runId: input.runId },
		"review",
	);
	await reviewHarnessTriageProposal(
		scope,
		input.runId,
		input.proposalId,
		input.decision,
	);
	return getPrivateTriageResult(actor, {
		projectId: input.projectId,
		runId: input.runId,
	});
}

function command<T>(fn: (actor: TriageActor, raw: unknown) => Promise<T>) {
	return async (actor: TriageActor, raw: unknown): Promise<T> => {
		try {
			return await fn(actor, raw);
		} catch (error) {
			if (error instanceof ORPCError || error instanceof z.ZodError) {
				throw error;
			}
			const code =
				error && typeof error === "object" && "code" in error
					? String(error.code)
					: "";
			if (code === "NOT_FOUND") {
				throw new ORPCError("NOT_FOUND");
			}
			if (code === "INSUFFICIENT_PERMISSION") {
				deliverySignalPermissionDenied();
			}
			if (code === "CONFLICT") {
				throw new ORPCError("CONFLICT", {
					message:
						"The saved triage request conflicts with this input.",
				});
			}
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message: "Private signal review is temporarily unavailable.",
				data: { code: "TRIAGE_UNAVAILABLE" },
			});
		}
	};
}
export const privateTriageCommands = {
	list: command(listPrivateTriageRuns),
	start: command(startPrivateTriage),
	status: command(getPrivateTriageStatus),
	result: command(getPrivateTriageResult),
	cancel: command(cancelPrivateTriage),
	review: command(reviewPrivateTriage),
};
