/** Private-source commands shared by authenticated project transports. */
import { createHash, timingSafeEqual } from "node:crypto";
import { ORPCError } from "@orpc/server";
import {
	normalizeDeliverySignalCaptureRevision,
	qualifySlackDeliverySource,
	readExactSlackDeliveryMessage,
	SlackDeliveryCaptureError,
	type SlackDeliverySourceProof,
} from "@repo/connectors";
import { isDeliverySourceCaptureWindow } from "@repo/connectors/delivery-source-capture-limits";
import {
	canEditProject,
	changeDeliverySourceWatchState,
	configureDeliverySourceWatch,
	DeliverySourceStoreError,
	db,
	getLastOwnedDeliverySourceCaptureCommand,
	getOwnedDeliverySourceCaptureCancellation,
	getOwnedDeliverySourceCaptureCommandByWorkflowId,
	getOwnedDeliverySourceCommand,
	getOwnedDeliverySourceObservation,
	getOwnedDeliverySourceWatch,
	listOwnedDeliverySlackIntegrations,
	listOwnedDeliverySourceObservations,
	listOwnedDeliverySourceWatches,
	prepareDeliverySourceCancelCommand,
	prepareDeliverySourceCaptureCommand,
} from "@repo/database";
import {
	hasPermission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
import { getTemporalClient } from "@repo/temporal/client";
import {
	DELIVERY_SOURCE_ADAPTER_VERSION,
	DeliverySourceAccessError,
	encodeDeliverySourceSnapshot,
	inspectOwnedSlackDeliveryIntegration,
	loadPinnedSlackDeliveryCredentials,
	savedSlackDeliveryCredentialPairAvailable,
} from "@repo/temporal/delivery-source-access";
import {
	DELIVERY_SOURCE_CAPTURE_ADMISSION_WINDOW_MS,
	DELIVERY_SOURCE_CAPTURE_EXECUTION_TIMEOUT_MS,
	DELIVERY_SOURCE_CAPTURE_MAX_CAPTURED,
	DELIVERY_SOURCE_CAPTURE_MAX_CIPHERTEXT_CHARS,
	DELIVERY_SOURCE_CAPTURE_MAX_SNAPSHOT_BYTES,
	DELIVERY_SOURCE_CAPTURE_MAX_TEXT_BYTES,
	DELIVERY_SOURCE_CAPTURE_MIN_RETENTION_MS,
	DELIVERY_SOURCE_CAPTURE_TASK_QUEUE,
} from "@repo/temporal/delivery-source-capture-contracts";
import {
	getPrivateDeliverySourceAvailability,
	PrivateDeliverySourceUnavailableError,
	requirePrivateDeliverySourceAvailability,
} from "@repo/temporal/delivery-source-readiness";
import { decryptApiKey, isEncryptedApiKey } from "@repo/utils";
import type { WorkflowExecutionDescription } from "@temporalio/client";
import { z } from "zod";
import { resolveEffectiveProjectPermissions } from "../../../lib/effective-project-permissions";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	type DeliverySignalActor,
	type DeliverySignalProject,
	deliverySignalPermissionDenied,
	requireDeliverySignalProjectAccess,
} from "./delivery-signals";
import {
	deliverySourceCancelInput,
	deliverySourceCaptureInput,
	deliverySourceConfigureInput,
	deliverySourceEvidence,
	deliverySourceEvidenceInput,
	deliverySourceInspectInput,
	deliverySourceInspection,
	deliverySourceList,
	deliverySourceObservationInput,
	deliverySourceObservationPage,
	deliverySourceProjectInput,
	deliverySourceRun,
	deliverySourceStateInput,
	deliverySourceWatch,
	deliverySourceWatchInput,
} from "./delivery-source-contracts";

/** Every transport passes authenticated facts; none are accepted from the request body. */
export async function requirePrivateDeliverySourceProject(
	actor: DeliverySignalActor,
	projectId: string,
	write = false,
): Promise<DeliverySignalProject> {
	const scope = await requireDeliverySignalProjectAccess(actor, projectId);
	if (write) {
		if (!(await canEditProject(projectId, actor.userId))) {
			deliverySignalPermissionDenied();
		}
		const effective = await resolveEffectiveProjectPermissions(
			projectId,
			actor.userId,
		);
		if (
			!effective ||
			effective.organizationId !== scope.organizationId ||
			!hasPermission(effective.permissions, Permissions.STORY_UPDATE)
		) {
			deliverySignalPermissionDenied();
		}
	}
	await requirePrivateDeliverySourceIntegrationPermission(scope, false);
	return scope;
}
async function requirePrivateDeliverySourceIntegrationPermission(
	scope: DeliverySignalProject,
	network: boolean,
) {
	const member = await db.member.findUnique({
		where: {
			organizationId_userId: {
				organizationId: scope.organizationId,
				userId: scope.userId,
			},
		},
		select: { role: true },
	});
	if (!member) {
		deliverySignalPermissionDenied();
	}
	const permissions = resolveOrgPermissions(member.role);
	if (
		!hasPermission(permissions, Permissions.INTEGRATION_READ) ||
		(network && !hasPermission(permissions, Permissions.INTEGRATION_USE))
	) {
		deliverySignalPermissionDenied();
	}
}
async function authorize(
	actor: DeliverySignalActor,
	projectId: string,
	write = false,
	network = false,
	allowUnavailable = false,
) {
	const scope = await requirePrivateDeliverySourceProject(
		actor,
		projectId,
		write,
	);
	if (network) {
		await requirePrivateDeliverySourceIntegrationPermission(scope, true);
	}
	if (!allowUnavailable) {
		await requirePrivateDeliverySourceAvailability();
	}
	return scope;
}
/** Shared server-only authority check for fresh private evidence consumers. */
export async function requirePrivateDeliverySourceEvidenceAccess(
	actor: DeliverySignalActor,
	projectId: string,
) {
	return authorize(actor, projectId, false, true);
}
function sourceNotFound(): never {
	throw new ORPCError("NOT_FOUND", { message: "Private source not found." });
}
function sourceChanged(): never {
	throw new ORPCError("CONFLICT", {
		message: "The private source changed. Reload before retrying.",
		data: { code: "SOURCE_CHANGED" },
	});
}
function unavailable(): never {
	throw new ORPCError("SERVICE_UNAVAILABLE", {
		message: "Private sources are temporarily unavailable.",
		data: { code: "UNAVAILABLE" },
	});
}

/** Hashes only bounded canonical input; never secrets, source prose or transport context. */
function inputHash(operation: string, input: unknown) {
	return createHash("sha256")
		.update(JSON.stringify([1, operation, input]))
		.digest("hex");
}
function digestMatches(a: string, b: string) {
	if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) {
		return false;
	}
	return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
const cursorSchema = z.strictObject({
	version: z.literal(1),
	organizationId: z.string(),
	userId: z.string(),
	projectId: z.string(),
	watchId: z.string(),
	id: z.string().min(1).max(200),
	capturedAt: z.iso.datetime(),
	order: z.literal("capturedAt_desc_id_desc"),
});
function observationCursor(
	scope: DeliverySignalProject,
	watchId: string,
	raw: unknown,
) {
	if (raw === undefined) {
		return undefined;
	}
	try {
		if (
			typeof raw !== "string" ||
			raw.length > 2048 ||
			!/^[A-Za-z0-9_-]+$/.test(raw)
		) {
			throw Error();
		}
		const decoded = Buffer.from(raw, "base64url");
		if (decoded.toString("base64url") !== raw) {
			throw Error();
		}
		const value = cursorSchema.parse(JSON.parse(decoded.toString("utf8")));
		if (
			value.organizationId !== scope.organizationId ||
			value.userId !== scope.userId ||
			value.projectId !== scope.projectId ||
			value.watchId !== watchId
		) {
			throw Error();
		}
		return { id: value.id, capturedAt: new Date(value.capturedAt) };
	} catch {
		throw new ORPCError("BAD_REQUEST", {
			message: "Invalid cursor. Reload private observations.",
		});
	}
}
function nextObservationCursor(
	scope: DeliverySignalProject,
	watchId: string,
	row: { id: string; capturedAt: Date },
) {
	return Buffer.from(
		JSON.stringify({
			version: 1,
			...scope,
			watchId,
			id: row.id,
			capturedAt: row.capturedAt.toISOString(),
			order: "capturedAt_desc_id_desc",
		}),
	).toString("base64url");
}

type Scope = DeliverySignalProject;
type Watch = NonNullable<
	Awaited<ReturnType<typeof getOwnedDeliverySourceWatch>>
>;
type Receipt = NonNullable<
	Awaited<ReturnType<typeof getOwnedDeliverySourceCommand>>
>;
type NativeClient = Awaited<ReturnType<typeof getTemporalClient>>;
type Run = z.infer<typeof deliverySourceRun>;
const WORKFLOW = "deliverySourceCaptureWorkflow";
const ADMISSION_WINDOW_MS = DELIVERY_SOURCE_CAPTURE_ADMISSION_WINDOW_MS;
const NAMESPACE_RETENTION_FLOOR_MS = DELIVERY_SOURCE_CAPTURE_MIN_RETENTION_MS;
const RPC_MS = 5_000;
const resultSchema = z.strictObject({
	captured: z
		.number()
		.int()
		.nonnegative()
		.max(DELIVERY_SOURCE_CAPTURE_MAX_CAPTURED),
	hasMore: z.boolean(),
	coverage: z.enum(["ROOT_MESSAGES_ONLY", "PARTIAL"]),
});
const memoSchema = z.strictObject({
	version: z.literal(1),
	routingDigest: z.string().regex(/^[a-f0-9]{64}$/),
	organizationId: z.string(),
	projectId: z.string(),
	userId: z.string(),
	watchId: z.string(),
	requestId: z.uuid(),
	payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
	configVersion: z.number().int().positive(),
	grantRevision: z.number().int().positive(),
	mode: z.enum(["RECENT", "CONTINUE", "BACKFILL"]),
	window: z
		.strictObject({ start: z.iso.datetime(), end: z.iso.datetime() })
		.optional(),
});

/** Dependency failures never reflect provider bodies, identifiers, credentials or native history. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof ORPCError || error instanceof z.ZodError) {
			throw error;
		}
		if (error instanceof PrivateDeliverySourceUnavailableError) {
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message:
					"Private source capture is not available in this deployment.",
				data: { code: "PRIVATE_SOURCE_CAPTURE_UNAVAILABLE" },
			});
		}
		if (error instanceof DeliverySourceStoreError) {
			if (error.code === "NOT_FOUND") {
				sourceNotFound();
			}
			if (error.code === "INSUFFICIENT_PERMISSION") {
				deliverySignalPermissionDenied();
			}
			if (error.code === "INVALID_INPUT") {
				throw new ORPCError("BAD_REQUEST", {
					message: "Invalid private source request.",
				});
			}
			if (error.code === "IDEMPOTENCY_CONFLICT") {
				throw new ORPCError("CONFLICT", {
					message:
						"This request ID belongs to different input. Retry the original request or use a new ID.",
					data: { code: "IDEMPOTENCY_CONFLICT" },
				});
			}
			if (error.code === "CAPTURE_CONFLICT") {
				throw new ORPCError("CONFLICT", {
					message:
						"The previous capture outcome must be confirmed before starting another.",
					data: { code: "CAPTURE_CONFLICT" },
				});
			}
			sourceChanged();
		}
		if (error instanceof SlackDeliveryCaptureError) {
			if (error.code === "SLACK_DELIVERY_RATE_LIMITED") {
				throw new ORPCError("TOO_MANY_REQUESTS", {
					message:
						"Slack temporarily limited this source request. Retry later.",
					data: { code: "SOURCE_RATE_LIMITED" },
				});
			}
			if (error.code === "SLACK_DELIVERY_MESSAGE_UNAVAILABLE") {
				throw new ORPCError("CONFLICT", {
					message: "This evidence could not be freshly verified.",
					data: { code: "SOURCE_EVIDENCE_UNAVAILABLE" },
				});
			}
			if (error.code === "SLACK_DELIVERY_ACCESS_DENIED") {
				throw new ORPCError("FORBIDDEN", {
					message:
						"Current access to this private source could not be established.",
					data: { code: "SOURCE_ACCESS_DENIED" },
				});
			}
		}
		if (error instanceof DeliverySourceAccessError) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Your private source credentials could not be verified.",
				data: { code: "SOURCE_CREDENTIAL_UNAVAILABLE" },
			});
		}
		return unavailable();
	}
}
function captureInput(receipt: Receipt | null | undefined) {
	if (
		!receipt ||
		receipt.operation !== "CAPTURE" ||
		!receipt.expectedVersion ||
		!receipt.captureMode
	) {
		return null;
	}
	return {
		requestId: receipt.requestId,
		expectedVersion: receipt.expectedVersion,
		mode: receipt.captureMode,
		...(receipt.captureMode === "BACKFILL"
			? {
					window: {
						start: receipt.captureWindowStart?.toISOString(),
						end: receipt.captureWindowEnd?.toISOString(),
					},
				}
			: {}),
	};
}
function watchRecord(watch: Watch, last: Receipt | null = null) {
	return deliverySourceWatch.parse({
		id: watch.id,
		provider: "SLACK",
		label: watch.label,
		state: watch.state,
		version: watch.version,
		visibility: "ONLY_ME",
		retentionDays: watch.retentionDays,
		verifiedAt: watch.verifiedAt.toISOString(),
		createdAt: watch.createdAt.toISOString(),
		lastRequestId: watch.lastRequestId,
		hasMore: watch.captureWindowStart !== null && !watch.captureComplete,
		captureWindow:
			watch.captureWindowStart && watch.captureWindowEnd
				? {
						start: watch.captureWindowStart.toISOString(),
						end: watch.captureWindowEnd.toISOString(),
						complete: watch.captureComplete,
					}
				: null,
		lastCaptureInput: captureInput(last),
	});
}
function assertPinnedProof(
	proof: SlackDeliverySourceProof,
	pinned: Awaited<ReturnType<typeof loadPinnedSlackDeliveryCredentials>>,
) {
	const { watch, grant } = pinned.context;
	if (
		proof.teamId !== watch.installationId ||
		proof.channelId !== watch.containerId ||
		proof.humanUserId !== grant.humanUserId ||
		proof.botId !== grant.botId ||
		proof.botUserId !== grant.botUserId
	) {
		sourceChanged();
	}
}
function proofRecord(
	proof: SlackDeliverySourceProof,
	label: string,
	verifiedAt: Date,
) {
	return {
		installationId: proof.teamId,
		containerId: proof.channelId,
		humanUserId: proof.humanUserId,
		botId: proof.botId,
		botUserId: proof.botUserId,
		adapterVersion: DELIVERY_SOURCE_ADAPTER_VERSION,
		label,
		verifiedAt,
	};
}
function exactMessageBounds(timestamp: string) {
	if (!/^(0|[1-9]\d{0,11})(\.\d{1,9})?$/.test(timestamp)) {
		sourceChanged();
	}
	const [whole, fraction = ""] = timestamp.split(".");
	const tick =
		BigInt(whole) * BigInt(1_000_000_000) +
		BigInt(fraction.padEnd(9, "0")) +
		BigInt(1);
	return {
		oldest: timestamp,
		latest: `${tick / BigInt(1_000_000_000)}.${String(tick % BigInt(1_000_000_000)).padStart(9, "0")}`,
	};
}
async function owned(scope: Scope, watchId: string, write = false) {
	const watch = await getOwnedDeliverySourceWatch(scope, watchId, write);
	if (!watch) {
		sourceNotFound();
	}
	return watch;
}
async function replay(
	scope: Scope,
	requestId: string,
	operation: string,
	hash: string,
) {
	const receipt = await getOwnedDeliverySourceCommand(
		scope,
		requestId,
		true,
		operation,
	);
	if (receipt && !digestMatches(receipt.payloadHash, hash)) {
		throw new ORPCError("CONFLICT", {
			message: "This request ID belongs to different input.",
			data: { code: "IDEMPOTENCY_CONFLICT" },
		});
	}
	if (receipt) {
		await owned(scope, receipt.watchId, true);
	}
	return receipt;
}

export async function listDeliverySourceWatches(
	actor: DeliverySignalActor,
	raw: unknown,
) {
	return guarded(async () => {
		const input = deliverySourceProjectInput.parse(raw);
		const scope = await authorize(
			actor,
			input.projectId,
			false,
			false,
			true,
		);
		const availability = await getPrivateDeliverySourceAvailability();
		if (availability.state !== "ENABLED") {
			return deliverySourceList.parse({
				version: 1,
				availability,
				watches: [],
				connections: [],
			});
		}
		const [watches, integrations] = await Promise.all([
			listOwnedDeliverySourceWatches(scope),
			listOwnedDeliverySlackIntegrations(scope),
		]);
		return deliverySourceList.parse({
			version: 1,
			availability,
			watches: watches.map((watch) =>
				watchRecord(watch, watch.lastCaptureCommand),
			),
			connections: integrations.map((integration) => ({
				id: integration.id,
				name: integration.name.slice(0, 200).replace(/\p{Cc}/gu, " "),
				supportsPrivateCapture:
					savedSlackDeliveryCredentialPairAvailable(
						integration.credentials,
					),
			})),
		});
	});
}
export async function inspectDeliverySource(
	actor: DeliverySignalActor,
	raw: unknown,
) {
	return guarded(async () => {
		const input = deliverySourceInspectInput.parse(raw);
		const scope = await authorize(actor, input.projectId, false, true);
		const inspected = await inspectOwnedSlackDeliveryIntegration(
			scope,
			input.integrationId,
			input.channelId,
		);
		// Network results never survive revoked current actor/object access.
		await authorize(actor, input.projectId, false, true);
		return deliverySourceInspection.parse({
			version: 1,
			provider: "SLACK",
			label: inspected.label,
			visibility: "ONLY_ME",
			checkedAt: inspected.checkedAt.toISOString(),
			coverage: "ROOT_MESSAGES_ONLY",
		});
	});
}
export async function configureDeliverySource(
	actor: DeliverySignalActor,
	raw: unknown,
) {
	return guarded(async () => {
		const input = deliverySourceConfigureInput.parse(raw);
		const scope = await authorize(actor, input.projectId, true, true);
		const hash = inputHash("CONFIGURE", input);
		const prior = await replay(scope, input.requestId, "CONFIGURE", hash);
		if (prior) {
			return watchRecord(
				await owned(scope, prior.watchId, true),
				await getLastOwnedDeliverySourceCaptureCommand(
					scope,
					prior.watchId,
				),
			);
		}
		const inspected = await inspectOwnedSlackDeliveryIntegration(
			scope,
			input.integrationId,
			input.channelId,
		);
		await authorize(actor, input.projectId, true, true);
		const watch = await configureDeliverySourceWatch(scope, {
			integrationId: input.integrationId,
			requestId: input.requestId,
			payloadHash: hash,
			retentionDays: input.retentionDays,
			proof: proofRecord(
				inspected.proof,
				inspected.label,
				inspected.checkedAt,
			),
		});
		if (!watch) {
			sourceNotFound();
		}
		return watchRecord(
			watch,
			await getLastOwnedDeliverySourceCaptureCommand(scope, watch.id),
		);
	});
}
export async function updateDeliverySourceState(
	actor: DeliverySignalActor,
	raw: unknown,
) {
	return guarded(async () => {
		const input = deliverySourceStateInput.parse(raw);
		const network = input.action === "RESUME";
		const scope = await authorize(actor, input.projectId, true, network);
		const hash = inputHash(input.action, input);
		const prior = await replay(scope, input.requestId, input.action, hash);
		if (prior) {
			return watchRecord(
				await owned(scope, prior.watchId, true),
				await getLastOwnedDeliverySourceCaptureCommand(
					scope,
					prior.watchId,
				),
			);
		}
		const previous = await owned(scope, input.watchId, true);
		let proof: ReturnType<typeof proofRecord> | undefined;
		if (network) {
			const pinned = await loadPinnedSlackDeliveryCredentials(
				scope,
				input.watchId,
				true,
			);
			const verified = await qualifySlackDeliverySource(
				pinned.adapterInput,
			);
			assertPinnedProof(verified, pinned);
			proof = proofRecord(verified, previous.label, new Date());
		}
		await authorize(actor, input.projectId, true, network);
		const watch = await changeDeliverySourceWatchState(scope, {
			...input,
			payloadHash: hash,
			...(proof ? { proof } : {}),
		});
		// DB revocation/purge/version fencing is committed before best-effort native cancellation.
		if (input.action !== "RESUME") {
			await cancelFencedCapture(scope, previous.id);
		}
		if (!watch) {
			sourceNotFound();
		}
		return watchRecord(
			watch,
			await getLastOwnedDeliverySourceCaptureCommand(scope, watch.id),
		);
	});
}

function workflowId(
	scope: Scope,
	watchId: string,
	requestId: string,
	routingDigest: string,
) {
	if (!/^[a-f0-9]{64}$/.test(routingDigest)) {
		unavailable();
	}
	return `delivery-source-${inputHash("NATIVE_CAPTURE", [scope.organizationId, scope.projectId, scope.userId, watchId, requestId, routingDigest])}`;
}
function receiptWorkflowId(receipt: Receipt) {
	if (!receipt.workflowId) {
		sourceChanged();
	}
	return receipt.workflowId;
}
function memo(scope: Scope, receipt: Receipt, routingDigest: string) {
	return memoSchema.parse({
		version: 1,
		routingDigest,
		...scope,
		watchId: receipt.watchId,
		requestId: receipt.requestId,
		payloadHash: receipt.payloadHash,
		configVersion: receipt.expectedVersion,
		grantRevision: receipt.grantRevision,
		mode: receipt.captureMode,
		...(receipt.captureMode === "BACKFILL"
			? {
					window: {
						start: receipt.captureWindowStart?.toISOString(),
						end: receipt.captureWindowEnd?.toISOString(),
					},
				}
			: {}),
	});
}
function unknownRun(receipt: Receipt): Run {
	return {
		version: 1,
		state: "OUTCOME_UNKNOWN",
		requestId: receipt.requestId,
		coverage: null,
		captured: null,
		hasMore: false,
		message:
			"Capture outcome could not be confirmed. Retry the same request; do not replace its ID.",
	};
}
function cancellationRun(run: Run): Run {
	if (["COMPLETED", "FAILED", "CANCELLED"].includes(run.state)) {
		return run;
	}
	return {
		...run,
		message:
			run.state === "RUNNING"
				? "Cancellation is recorded. Waiting for the native execution to stop."
				: "Cancellation is recorded. Native outcome has not been confirmed; check the same capture status.",
	};
}
async function cancellationRequested(scope: Scope, receipt: Receipt) {
	return Boolean(
		await getOwnedDeliverySourceCaptureCancellation(scope, {
			watchId: receipt.watchId,
			workflowId: receiptWorkflowId(receipt),
		}),
	);
}
function notStarted(): Run {
	return {
		version: 1,
		state: "NOT_STARTED",
		requestId: null,
		coverage: null,
		captured: null,
		hasMore: false,
		message: null,
	};
}
function nativeStatus(name: string): Run["state"] {
	switch (name) {
		case "RUNNING":
			return "RUNNING";
		case "COMPLETED":
			return "COMPLETED";
		case "CANCELLED":
			return "CANCELLED";
		case "FAILED":
		case "TIMED_OUT":
		case "TERMINATED":
			return "FAILED";
		default:
			return "OUTCOME_UNKNOWN";
	}
}
type NativeObservation =
	| { kind: "FOUND"; description: WorkflowExecutionDescription; run: Run }
	| { kind: "NOT_FOUND"; run: Run; routing: Routing }
	| { kind: "UNKNOWN"; run: Run };
async function observeNative(
	client: NativeClient,
	scope: Scope,
	receipt: Receipt,
): Promise<NativeObservation> {
	let routing: Routing;
	try {
		routing = await qualifyNamespace(client, false);
	} catch {
		return { kind: "UNKNOWN", run: unknownRun(receipt) };
	}
	if (
		!receipt.workflowId ||
		receipt.workflowId !==
			workflowId(
				scope,
				receipt.watchId,
				receipt.requestId,
				routing.digest,
			)
	) {
		sourceChanged();
	}
	let description: WorkflowExecutionDescription;
	try {
		description = await client.workflow.withDeadline(
			Date.now() + RPC_MS,
			() =>
				client.workflow
					.getHandle(
						workflowId(
							scope,
							receipt.watchId,
							receipt.requestId,
							routing.digest,
						),
					)
					.describe(),
		);
	} catch (error) {
		if (error instanceof Error && error.name === "WorkflowNotFoundError") {
			return { kind: "NOT_FOUND", run: unknownRun(receipt), routing };
		}
		return { kind: "UNKNOWN", run: unknownRun(receipt) };
	}
	const parsed = memoSchema.safeParse(
		description.memo?.fabricDeliverySourceCapture,
	);
	if (
		description.type !== WORKFLOW ||
		!parsed.success ||
		inputHash("NATIVE_MEMO", parsed.data) !==
			inputHash("NATIVE_MEMO", memo(scope, receipt, routing.digest)) ||
		!description.runId
	) {
		sourceChanged();
	}
	const state = nativeStatus(description.status.name);
	let run: Run = {
		version: 1,
		state,
		requestId: receipt.requestId,
		coverage: null,
		captured: null,
		hasMore: false,
		message:
			state === "FAILED"
				? "Capture did not complete. Inspect current access before a new request."
				: null,
	};
	if (state === "OUTCOME_UNKNOWN") {
		run = unknownRun(receipt);
	}
	if (state === "COMPLETED") {
		try {
			const result = await client.workflow.withDeadline(
				Date.now() + RPC_MS,
				() =>
					client.workflow.result<
						() => Promise<z.infer<typeof resultSchema>>
					>(
						workflowId(
							scope,
							receipt.watchId,
							receipt.requestId,
							routing.digest,
						),
						description.runId,
						{
							followRuns: false,
						},
					),
			);
			const parsedResult = resultSchema.safeParse(result);
			if (!parsedResult.success) {
				return { kind: "FOUND", description, run: unknownRun(receipt) };
			}
			run = {
				...run,
				...parsedResult.data,
				...(parsedResult.data.hasMore
					? {
							coverage: "PARTIAL" as const,
							message:
								"Capture reached its bounded limit. Use CONTINUE with a new reviewed request to capture the next page.",
						}
					: {}),
			};
		} catch {
			return { kind: "FOUND", description, run: unknownRun(receipt) };
		}
	}
	return { kind: "FOUND", description, run };
}
/** Namespace qualification is read live, bounded, and never assumed from a deployment default. */
type Routing = { digest: string; retentionQualified: boolean };
async function qualifyNamespace(
	client: NativeClient,
	requireRetention = true,
): Promise<Routing> {
	try {
		const namespace = client.workflow.options.namespace;
		if (
			typeof namespace !== "string" ||
			!namespace.trim() ||
			namespace.length > 200
		) {
			unavailable();
		}
		const connection = z
			.object({
				options: z.object({ address: z.string().min(1).max(2048) }),
			})
			.safeParse(client.workflow.connection);
		if (!connection.success) {
			unavailable();
		}
		const result = await client.workflow.withDeadline(
			Date.now() + RPC_MS,
			() =>
				client.workflow.workflowService.describeNamespace({
					namespace,
				}),
		);
		const namespaceId = z
			.string()
			.min(1)
			.max(200)
			.refine(
				(value) => value.trim().length > 0 && !/\p{Cc}/u.test(value),
			)
			.safeParse(result.namespaceInfo?.id);
		if (!namespaceId.success || result.namespaceInfo?.name !== namespace) {
			unavailable();
		}
		const ttl = result.config?.workflowExecutionRetentionTtl;
		const seconds =
			ttl?.seconds === undefined ? Number.NaN : Number(ttl.seconds);
		const nanos = Number(ttl?.nanos ?? 0);
		const millis = seconds * 1000 + nanos / 1e6;
		if (
			!Number.isSafeInteger(seconds) ||
			seconds < 0 ||
			!Number.isInteger(nanos) ||
			nanos < 0 ||
			nanos >= 1e9 ||
			!Number.isFinite(millis)
		) {
			unavailable();
		}
		const retentionQualified = millis >= NAMESPACE_RETENTION_FLOOR_MS;
		if (requireRetention && !retentionQualified) {
			unavailable();
		}
		// Only this opaque digest enters native identity/memo; never endpoint names or credentials.
		return {
			digest: inputHash("NATIVE_ROUTING", [
				connection.data.options.address,
				namespace,
				namespaceId.data,
			]),
			retentionQualified,
		};
	} catch {
		return unavailable();
	}
}
function insideAdmission(receipt: Receipt) {
	const elapsed = Date.now() - receipt.createdAt.getTime();
	return (
		Number.isFinite(elapsed) &&
		elapsed >= 0 &&
		elapsed < ADMISSION_WINDOW_MS
	);
}
/** Native terminal proof or an explicit durable stop fence plus confirmed absence permits a new identity.
 * A missing history alone never proves completion. Cancellation remains attached to the old workflow,
 * so even a delayed start cannot read/commit a page after replacement. No evidence is deleted here.
 */
function priorCaptureCanBeReplaced(
	native: NativeObservation,
	receipt: Receipt,
	cancelled: boolean,
): boolean {
	if (native.kind === "FOUND") {
		return [
			"COMPLETED",
			"FAILED",
			"CANCELLED",
			"TIMED_OUT",
			"TERMINATED",
		].includes(native.description.status.name);
	}
	return (
		native.kind === "NOT_FOUND" &&
		native.routing.retentionQualified &&
		!insideAdmission(receipt) &&
		cancelled
	);
}
function presentNativeCapture(
	native: NativeObservation,
	receipt: Receipt,
	cancelled: boolean,
): Run {
	const run = cancelled ? cancellationRun(native.run) : native.run;
	if (run.state !== "OUTCOME_UNKNOWN") {
		return run;
	}
	if (priorCaptureCanBeReplaced(native, receipt, cancelled)) {
		return {
			...run,
			canStartNewCapture: true,
			message:
				"The earlier result is unavailable. You can start a new capture; existing evidence is retained.",
		};
	}
	if (native.kind === "NOT_FOUND" && !insideAdmission(receipt)) {
		return {
			...run,
			message:
				"The earlier outcome is unavailable. Cancel this request to fence any late start, then recheck status before a new capture. Existing evidence is retained.",
		};
	}
	return run;
}
async function retryOrObserveCapture(
	client: NativeClient,
	actor: DeliverySignalActor,
	scope: Scope,
	receipt: Receipt,
): Promise<Run> {
	const cancelled = await cancellationRequested(scope, receipt);
	const before = await observeNative(client, scope, receipt);
	if (cancelled) {
		return presentNativeCapture(before, receipt, true);
	}
	if (before.kind !== "NOT_FOUND") {
		return presentNativeCapture(before, receipt, false);
	}
	if (!insideAdmission(receipt)) {
		return presentNativeCapture(before, receipt, false);
	}
	if (!before.routing.retentionQualified) {
		return unknownRun(receipt);
	}
	await authorize(actor, scope.projectId, true, true);
	const pinned = await loadPinnedSlackDeliveryCredentials(
		scope,
		receipt.watchId,
		true,
	);
	if (
		pinned.context.watch.state !== "ACTIVE" ||
		pinned.context.watch.version !== receipt.expectedVersion ||
		pinned.context.watch.grantRevision !== receipt.grantRevision ||
		pinned.context.watch.lastWorkflowId !== receipt.workflowId
	) {
		sourceChanged();
	}
	const verified = await qualifySlackDeliverySource(pinned.adapterInput);
	assertPinnedProof(verified, pinned);
	// Recheck current permissions and persisted fencing after provider I/O, immediately before RPC.
	await authorize(actor, scope.projectId, true, true);
	const current = await loadPinnedSlackDeliveryCredentials(
		scope,
		receipt.watchId,
		true,
	);
	if (
		current.context.watch.state !== "ACTIVE" ||
		current.context.watch.version !== receipt.expectedVersion ||
		current.context.watch.grantRevision !== receipt.grantRevision ||
		current.context.watch.lastWorkflowId !== receipt.workflowId ||
		current.context.integration.id !== pinned.context.integration.id ||
		current.context.integration.credentials !==
			pinned.context.integration.credentials ||
		current.context.grant.id !== pinned.context.grant.id
	) {
		sourceChanged();
	}
	if (!insideAdmission(receipt)) {
		return unknownRun(receipt);
	}
	let routing: Routing;
	try {
		routing = await qualifyNamespace(client);
	} catch {
		return unknownRun(receipt);
	}
	if (
		receipt.workflowId !==
		workflowId(scope, receipt.watchId, receipt.requestId, routing.digest)
	) {
		sourceChanged();
	}
	if (await cancellationRequested(scope, receipt)) {
		return cancellationRun(unknownRun(receipt));
	}
	const bound = memo(scope, receipt, routing.digest);
	try {
		await client.workflow.withDeadline(
			Math.min(
				Date.now() + 8000,
				receipt.createdAt.getTime() + ADMISSION_WINDOW_MS,
			),
			() =>
				client.workflow.start(
					WORKFLOW,
					withCorrelationMemo({
						workflowId: workflowId(
							scope,
							receipt.watchId,
							receipt.requestId,
							routing.digest,
						),
						taskQueue: DELIVERY_SOURCE_CAPTURE_TASK_QUEUE,
						workflowExecutionTimeout:
							DELIVERY_SOURCE_CAPTURE_EXECUTION_TIMEOUT_MS,
						workflowRunTimeout:
							DELIVERY_SOURCE_CAPTURE_EXECUTION_TIMEOUT_MS,
						workflowIdReusePolicy: "REJECT_DUPLICATE",
						workflowIdConflictPolicy: "USE_EXISTING",
						args: [
							{
								organizationId: scope.organizationId,
								userId: scope.userId,
								projectId: scope.projectId,
								watchId: receipt.watchId,
								grantRevision: bound.grantRevision,
								configVersion: bound.configVersion,
								mode: bound.mode,
								...(bound.window
									? { window: bound.window }
									: {}),
							},
						],
						memo: { fabricDeliverySourceCapture: bound },
					}),
				),
		);
	} catch {
		// A lost response is not proof of refusal. Only exact native state may resolve it.
	}
	const after = await observeNative(client, scope, receipt);
	return presentNativeCapture(
		after,
		receipt,
		await cancellationRequested(scope, receipt),
	);
}
export async function startDeliverySourceCapture(
	actor: DeliverySignalActor,
	raw: unknown,
) {
	return guarded(async () => {
		const input = deliverySourceCaptureInput.parse(raw);
		const scope = await authorize(actor, input.projectId, true, true);
		const hash = inputHash("CAPTURE", input);
		const existing = await replay(scope, input.requestId, "CAPTURE", hash);
		let client: NativeClient;
		try {
			client = await getTemporalClient();
		} catch {
			if (existing) {
				return unknownRun(existing);
			}
			return unavailable();
		}
		if (existing) {
			return deliverySourceRun.parse(
				await retryOrObserveCapture(client, actor, scope, existing),
			);
		}
		if (
			input.window &&
			!isDeliverySourceCaptureWindow(input.window, Date.now())
		)
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Choose a past window of up to seven days within the last 90 days.",
			});
		const watch = await owned(scope, input.watchId, true);
		const previous = await getLastOwnedDeliverySourceCaptureCommand(
			scope,
			input.watchId,
		);
		if (previous) {
			const native = await observeNative(client, scope, previous);
			if (
				!priorCaptureCanBeReplaced(
					native,
					previous,
					await cancellationRequested(scope, previous),
				)
			) {
				throw new ORPCError("CONFLICT", {
					message:
						"Confirm the previous capture outcome before starting another.",
					data: { code: "CAPTURE_CONFLICT" },
				});
			}
		}
		const routing = await qualifyNamespace(client);
		const pinned = await loadPinnedSlackDeliveryCredentials(
			scope,
			input.watchId,
			true,
		);
		const verified = await qualifySlackDeliverySource(pinned.adapterInput);
		assertPinnedProof(verified, pinned);
		await authorize(actor, input.projectId, true, true);
		const admitted = await prepareDeliverySourceCaptureCommand(scope, {
			watchId: input.watchId,
			requestId: input.requestId,
			expectedVersion: input.expectedVersion,
			mode: input.mode,
			...(input.window ? { window: input.window } : {}),
			payloadHash: hash,
			workflowId: workflowId(
				scope,
				input.watchId,
				input.requestId,
				routing.digest,
			),
			expectedLastRequestId: watch.lastRequestId,
		});
		return deliverySourceRun.parse(
			await retryOrObserveCapture(client, actor, scope, admitted.receipt),
		);
	});
}
export async function getDeliverySourceCaptureStatus(
	actor: DeliverySignalActor,
	raw: unknown,
) {
	return guarded(async () => {
		const input = deliverySourceWatchInput.parse(raw);
		const scope = await authorize(actor, input.projectId);
		await owned(scope, input.watchId);
		const receipt = await getLastOwnedDeliverySourceCaptureCommand(
			scope,
			input.watchId,
		);
		if (!receipt) {
			return notStarted();
		}
		try {
			const native = await observeNative(
				await getTemporalClient(),
				scope,
				receipt,
			);
			return deliverySourceRun.parse(
				presentNativeCapture(
					native,
					receipt,
					await cancellationRequested(scope, receipt),
				),
			);
		} catch (error) {
			if (error instanceof ORPCError) {
				throw error;
			}
			return unknownRun(receipt);
		}
	});
}
async function cancelFencedCapture(scope: Scope, watchId: string) {
	try {
		const receipt = await getLastOwnedDeliverySourceCaptureCommand(
			scope,
			watchId,
		);
		if (!receipt) {
			return;
		}
		const client = await getTemporalClient();
		const native = await observeNative(client, scope, receipt);
		if (native.kind === "FOUND" && native.run.state === "RUNNING") {
			await client.workflow.withDeadline(Date.now() + RPC_MS, () =>
				client.workflow
					.getHandle(
						receiptWorkflowId(receipt),
						native.description.runId,
					)
					.cancel(),
			);
		}
	} catch {
		/* DB fencing is authoritative; no provider/body/error is logged. */
	}
}
export async function cancelDeliverySourceCapture(
	actor: DeliverySignalActor,
	raw: unknown,
) {
	return guarded(async () => {
		const input = deliverySourceCancelInput.parse(raw);
		const scope = await authorize(actor, input.projectId, true);
		await owned(scope, input.watchId, true);
		const hash = inputHash("CANCEL", input);
		let cancellation = await replay(scope, input.requestId, "CANCEL", hash);
		if (!cancellation) {
			const current = await getLastOwnedDeliverySourceCaptureCommand(
				scope,
				input.watchId,
			);
			if (!current?.workflowId) {
				throw new ORPCError("CONFLICT", {
					message: "No capture has started for this watch.",
					data: { code: "CAPTURE_NOT_STARTED" },
				});
			}
			cancellation = (
				await prepareDeliverySourceCancelCommand(scope, {
					watchId: input.watchId,
					requestId: input.requestId,
					payloadHash: hash,
					workflowId: current.workflowId,
				})
			).receipt;
		}
		if (!cancellation.workflowId) {
			sourceChanged();
		}
		const capture = await getOwnedDeliverySourceCaptureCommandByWorkflowId(
			scope,
			{ watchId: input.watchId, workflowId: cancellation.workflowId },
		);
		if (!capture) {
			sourceNotFound();
		}
		let client: NativeClient;
		try {
			client = await getTemporalClient();
		} catch {
			return cancellationRun(unknownRun(capture));
		}
		const native = await observeNative(client, scope, capture);
		if (native.kind !== "FOUND" || native.run.state !== "RUNNING") {
			return presentNativeCapture(native, capture, true);
		}
		await authorize(actor, input.projectId, true);
		try {
			await client.workflow.withDeadline(Date.now() + RPC_MS, () =>
				client.workflow
					.getHandle(
						receiptWorkflowId(capture),
						native.description.runId,
					)
					.cancel(),
			);
		} catch {
			return cancellationRun(unknownRun(capture));
		}
		const after = await observeNative(client, scope, capture);
		return {
			...presentNativeCapture(after, capture, true),
			...(after.run.state === "RUNNING"
				? {
						message:
							"Cancellation requested. Check status until the native execution stops.",
					}
				: {}),
		};
	});
}

export async function listDeliverySourceObservations(
	actor: DeliverySignalActor,
	raw: unknown,
) {
	return guarded(async () => {
		const input = deliverySourceObservationInput.parse(raw);
		const scope = await authorize(actor, input.projectId);
		await owned(scope, input.watchId);
		const page = await listOwnedDeliverySourceObservations(scope, {
			watchId: input.watchId,
			limit: input.limit,
			cursor: observationCursor(scope, input.watchId, input.cursor),
		});
		const last = page.items.at(-1);
		return deliverySourceObservationPage.parse({
			version: 1,
			items: page.items.map((row) => ({
				id: row.id,
				capturedAt: row.capturedAt.toISOString(),
				expiresAt: row.expiresAt.toISOString(),
				change: row.change,
				hasConflict: row.hasConflict,
				coverage: "ROOT_MESSAGES_ONLY",
			})),
			nextCursor:
				page.hasMore && last
					? nextObservationCursor(scope, input.watchId, last)
					: null,
		});
	});
}
export async function getDeliverySourceEvidence(
	actor: DeliverySignalActor,
	raw: unknown,
	signal?: AbortSignal,
) {
	return guarded(async () => {
		signal?.throwIfAborted();
		const input = deliverySourceEvidenceInput.parse(raw);
		const scope = await authorize(actor, input.projectId, false, true);
		const observation = await getOwnedDeliverySourceObservation(
			scope,
			input,
		);
		if (
			!observation ||
			observation.hasConflict ||
			!observation.ciphertext ||
			observation.expiresAt <= new Date()
		) {
			sourceNotFound();
		}
		const pinned = await loadPinnedSlackDeliveryCredentials(
			scope,
			input.watchId,
		);
		// Use exactly the original message point, never a moving broad history range.
		const readInput = {
			...pinned.adapterInput,
			...exactMessageBounds(observation.externalItemId),
			messageTs: observation.externalItemId,
		};
		const current = signal
			? await readExactSlackDeliveryMessage(readInput, { signal })
			: await readExactSlackDeliveryMessage(readInput);
		signal?.throwIfAborted();
		assertPinnedProof(current.proof, pinned);
		if (
			Buffer.byteLength(current.message.text, "utf8") >
			DELIVERY_SOURCE_CAPTURE_MAX_TEXT_BYTES
		) {
			sourceChanged();
		}
		const snapshot = encodeDeliverySourceSnapshot(current.message);
		const normalizedRevision = normalizeDeliverySignalCaptureRevision(
			current.message.revision,
		);
		if (
			current.message.externalItemId !== observation.externalItemId ||
			normalizedRevision.kind !== observation.revisionKind ||
			normalizedRevision.value !== observation.revisionValue ||
			!digestMatches(snapshot.digest, observation.evidenceDigest)
		) {
			sourceChanged();
		}
		await authorize(actor, input.projectId, false, true);
		const [latest, context] = await Promise.all([
			getOwnedDeliverySourceObservation(scope, input),
			loadPinnedSlackDeliveryCredentials(scope, input.watchId),
		]);
		if (
			!latest ||
			latest.hasConflict ||
			latest.expiresAt <= new Date() ||
			latest.ciphertext !== observation.ciphertext ||
			latest.evidenceDigest !== observation.evidenceDigest ||
			context.context.watch.version !== pinned.context.watch.version ||
			context.context.integration.id !== pinned.context.integration.id ||
			context.context.integration.credentials !==
				pinned.context.integration.credentials ||
			context.context.grant.id !== pinned.context.grant.id ||
			context.context.grant.revision !== pinned.context.grant.revision
		) {
			sourceChanged();
		}
		if (
			!isEncryptedApiKey(latest.ciphertext) ||
			Buffer.byteLength(latest.ciphertext, "utf8") >
				DELIVERY_SOURCE_CAPTURE_MAX_CIPHERTEXT_CHARS
		) {
			sourceChanged();
		}
		let plaintext: string;
		try {
			plaintext = decryptApiKey(latest.ciphertext);
		} catch {
			return sourceChanged();
		}
		if (
			Buffer.byteLength(plaintext, "utf8") >
			DELIVERY_SOURCE_CAPTURE_MAX_SNAPSHOT_BYTES
		) {
			sourceChanged();
		}
		// Equality proves both stored encrypted evidence integrity and exact currently-authorized source bytes.
		if (
			!digestMatches(
				createHash("sha256").update(plaintext).digest("hex"),
				snapshot.digest,
			) ||
			plaintext !== snapshot.payload
		) {
			sourceChanged();
		}
		signal?.throwIfAborted();
		return deliverySourceEvidence.parse({
			version: 1,
			observationId: latest.id,
			text: current.message.text,
			capturedAt: latest.capturedAt.toISOString(),
			checkedAt: new Date().toISOString(),
			coverage: "ROOT_MESSAGES_ONLY",
			visibility: "ONLY_ME",
		});
	});
}
