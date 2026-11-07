/** Trusted finite execution host. Only worker activities call this entry point. */
import { createHash } from "node:crypto";
import type {
	SignalTriageAuthority,
	SignalTriagerHost,
} from "@repo/agent-runtime/harness/triage";
import {
	countUncertainHarnessTriageCalls,
	dispatchHarnessTriageCall,
	failHarnessTriageMetadata,
	finishHarnessTriageRun,
	getHarnessTriageFailureMetadata,
	getHarnessTriageRun,
	markHarnessTriageNativeRun,
	purgeExpiredHarnessTriageContent,
	recordHarnessTriageResponse,
	reserveHarnessTriageCall,
	type TriageScope,
	transitionHarnessTriageCall,
} from "@repo/database";
import { getTemporalClient } from "@repo/temporal/client";
import { decryptApiKey, encryptApiKey } from "@repo/utils";
import {
	assertTriagePins,
	authorizeTriage,
	checkTriageCredential,
	type TriageActor,
	triageLimits,
} from "./harness-triage-commands";
import { triageCredential, triageResult } from "./harness-triage-contracts";
import { createPrivateTriageEvidenceReader } from "./harness-triage-evidence";
import { generateTriageModelOnce, triageCharge } from "./harness-triage-model";
import {
	resolveTriageExecutionBinding,
	triageStoredModel,
} from "./harness-triage-native";
export async function executePrivateHarnessTriage(
	inputScope: TriageScope,
	runId: string,
	workflowId: string,
	nativeRunId: string,
	signal: AbortSignal,
) {
	const scope = {
		organizationId: inputScope.organizationId,
		projectId: inputScope.projectId,
		userId: inputScope.userId,
	};
	// Native ESM boundary: the Harness SDK and its loop runtime are ESM-only.
	const { runSignalTriager, SignalTriageError } = await import(
		"@repo/agent-runtime/harness/triage"
	);
	const row = await getHarnessTriageRun(scope, runId);
	if (
		!row ||
		row.workflowId !== workflowId ||
		(row.nativeRunId !== null && row.nativeRunId !== nativeRunId)
	) {
		throw Error("TRIAGE_AUTHORITY_UNAVAILABLE");
	}
	if (
		["COMPLETED", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"].includes(
			row.status,
		)
	) {
		return { runId, status: row.status };
	}
	await markHarnessTriageNativeRun(scope, runId, nativeRunId);
	const credential = triageCredential.parse(row.credential);
	const actor: TriageActor = {
		userId: scope.userId,
		organizationBinding: { organizationId: scope.organizationId },
		boundProjectId: scope.projectId,
		credential,
	};
	const stored = triageStoredModel.parse(row.model);
	const execution = await resolveTriageExecutionBinding(
		await getTemporalClient(),
	);
	if (execution.routingDigest !== stored.execution.routingDigest) {
		throw Error("TRIAGE_NATIVE_BINDING_UNAVAILABLE");
	}
	const pin = stored.pin;
	const limits = triageLimits();
	if (!limits) {
		throw Error("TRIAGE_NOT_ENABLED");
	}
	const payload = {
		goal: decryptApiKey(row.goalCiphertext),
		evidenceIds: (await assertTriagePins(scope, row.evidence))
			.map((x) => x.observationId)
			.sort(),
	};
	const authority: SignalTriageAuthority = {
		runId,
		organizationId: scope.organizationId,
		projectId: scope.projectId,
		actorId: scope.userId,
		inputHash: row.inputHash,
		evidence: await assertTriagePins(scope, row.evidence),
		model: { id: pin.modelString, maxOutputTokens: pin.maxOutputTokens },
	};
	const read = await createPrivateTriageEvidenceReader(
		actor,
		scope.projectId,
		credential.kind === "SESSION"
			? { kind: "SESSION" }
			: { kind: "API_KEY", scopes: credential.scopes },
	);
	const authorize: SignalTriagerHost["authorize"] = async (
		_authority,
		_phase,
		abort,
	) => {
		abort.throwIfAborted();
		await authorizeTriage(actor, scope.projectId, "start");
		await checkTriageCredential(scope, credential, "start");
		const current = await getHarnessTriageRun(scope, runId);
		if (
			!current ||
			current.cancelRequestedAt ||
			!["QUEUED", "RUNNING"].includes(current.status) ||
			current.workflowId !== workflowId ||
			current.inputHash !== row.inputHash
		) {
			return false;
		}
		await assertTriagePins(scope, row.evidence);
		abort.throwIfAborted();
		return true;
	};
	const host: SignalTriagerHost = {
		resolveAuthority: async (id, abort) => {
			if (id !== runId || !(await authorize(authority, "run", abort))) {
				throw Error("TRIAGE_AUTHORITY_UNAVAILABLE");
			}
			return authority;
		},
		authorize,
		readEvidence: read,
		budget: {
			reserve: async (input, abort) => {
				if (!(await authorize(authority, "model", abort))) {
					return null;
				}
				const reservedTokens =
					input.requestBytes + 8192 + input.maxOutputTokens;
				if (reservedTokens > pin.contextWindow) {
					return null;
				}
				const reservedMicroUsd = Math.max(
					1,
					triageCharge(
						pin,
						input.requestBytes + 8192,
						input.maxOutputTokens,
					),
				);
				const admission = await reserveHarnessTriageCall(scope, {
					callId: input.callId,
					runId,
					ordinal: Number(input.callId.split(":").at(-1)),
					requestDigest: input.requestDigest,
					reservedTokens,
					reservedMicroUsd,
					monthlyTokens: limits.monthlyTokens,
					monthlyMicroUsd: limits.monthlyMicroUsd,
				});
				if (!admission) {
					return null;
				}
				const base = {
					reservationId: admission.call.id,
					modelId: pin.modelString,
					maxOutputTokens: pin.maxOutputTokens,
					requestDigest: input.requestDigest,
				};
				return admission.dispatch === "REPLAY"
					? {
							...base,
							dispatch: "REPLAY",
							response: JSON.parse(
								decryptApiKey(
									admission.call.responseCiphertext!,
								),
							),
						}
					: { ...base, dispatch: "SEND_ONCE" };
			},
			release: (id) =>
				transitionHarnessTriageCall(scope, runId, id, "RELEASED"),
			markUnknown: (id) =>
				transitionHarnessTriageCall(scope, runId, id, "UNKNOWN"),
			settle: (id, usage) =>
				transitionHarnessTriageCall(scope, runId, id, "SETTLED", {
					tokens:
						usage.inputTokens +
						usage.outputTokens +
						(usage.cacheWriteTokens ?? 0),
					microUsd: triageCharge(
						pin,
						usage.inputTokens + (usage.cacheWriteTokens ?? 0),
						usage.outputTokens,
					),
				}),
		},
		generateOne: async (input) => {
			if (!(await authorize(authority, "model", input.signal))) {
				throw Error("TRIAGE_AUTHORITY_UNAVAILABLE");
			}
			const digest = createHash("sha256")
				.update(
					JSON.stringify({
						modelId: pin.modelString,
						maxOutputTokens: pin.maxOutputTokens,
						messages: input.request.messages,
						tools: input.request.tools,
					}),
				)
				.digest("hex");
			if (
				digest !== input.requestDigest ||
				input.callId !== input.reservationId ||
				!(await dispatchHarnessTriageCall(
					scope,
					runId,
					input.callId,
					digest,
				))
			) {
				throw Error("TRIAGE_DISPATCH_REFUSED");
			}
			const response = await generateTriageModelOnce(scope, pin, input);
			await recordHarnessTriageResponse(
				scope,
				runId,
				input.callId,
				encryptApiKey(JSON.stringify(response)),
			);
			return response;
		},
	};
	await finishHarnessTriageRun(scope, runId, "RUNNING");
	try {
		const result = await runSignalTriager(host, authority, payload, signal);
		if (!(await authorize(authority, "result", signal))) {
			throw new SignalTriageError("FORBIDDEN");
		}
		const parsed = triageResult.parse(result);
		await finishHarnessTriageRun(
			scope,
			runId,
			"COMPLETED",
			encryptApiKey(JSON.stringify(parsed)),
		);
		return {
			runId,
			status:
				(await getHarnessTriageRun(scope, runId))?.status ??
				"CANCELLED",
		};
	} catch (error) {
		const uncertain = await countUncertainHarnessTriageCalls(scope, runId);
		// Temporal retries safe, transient failures. Confirmed responses replay from
		// the encrypted ledger; a dispatched/unknown send is never repeated.
		if (
			!uncertain &&
			!signal.aborted &&
			(!(error instanceof SignalTriageError) ||
				["EVIDENCE_UNAVAILABLE", "MODEL_UNAVAILABLE"].includes(
					error.code,
				))
		) {
			throw Error("TRIAGE_RETRYABLE_UNAVAILABLE");
		}
		const failureCode = signal.aborted
			? "CANCELLED"
			: error instanceof SignalTriageError
				? error.code === "INVALID_INPUT"
					? "INVALID_RESULT"
					: error.code
				: "MODEL_UNAVAILABLE";
		const status = uncertain
			? "OUTCOME_UNKNOWN"
			: failureCode === "CANCELLED"
				? "CANCELLED"
				: "FAILED";
		await finishHarnessTriageRun(
			scope,
			runId,
			status,
			undefined,
			uncertain ? "OUTCOME_UNKNOWN" : failureCode,
		);
		return { runId, status };
	}
}
export { purgeExpiredHarnessTriageContent };

/** Metadata-only failure recording is allowed after actor/source revocation. */
export async function markPrivateTriageFailed(
	inputScope: TriageScope,
	id: string,
	workflowId: string,
	nativeRunId: string,
) {
	const scope = {
		organizationId: inputScope.organizationId,
		projectId: inputScope.projectId,
		userId: inputScope.userId,
	};
	const row = await getHarnessTriageFailureMetadata(
		scope,
		id,
		workflowId,
		nativeRunId,
	);
	if (!row) {
		return;
	}
	const binding = triageStoredModel.parse(row.model).execution;
	const current = await resolveTriageExecutionBinding(
		await getTemporalClient(),
	);
	if (binding.routingDigest !== current.routingDigest) {
		return;
	}
	const uncertain = await countUncertainHarnessTriageCalls(scope, id);
	await failHarnessTriageMetadata(
		scope,
		id,
		workflowId,
		uncertain
			? "OUTCOME_UNKNOWN"
			: row.cancelRequestedAt
				? "CANCELLED"
				: "FAILED",
		uncertain
			? "OUTCOME_UNKNOWN"
			: row.cancelRequestedAt
				? "CANCELLED"
				: "MODEL_UNAVAILABLE",
	);
}
