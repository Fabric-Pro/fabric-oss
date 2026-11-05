import { ORPCError } from "@orpc/server";
import {
	AgentPreviewAccessError,
	assertAgentPreviewAccess,
	previewRequestHash,
	previewWorkflowId,
} from "@repo/temporal/agent-preview-access";
import {
	AGENT_PREVIEW_MAX_BYTES,
	AGENT_PREVIEW_WORKFLOW,
	type AgentPreviewActor,
	type AgentPreviewRequest,
	type AgentPreviewState,
	type agentPreviewDraftSchema,
	agentPreviewStartSchema,
} from "@repo/temporal/agent-preview-contracts";
import { getTemporalClient } from "@repo/temporal/client";
import type { WorkflowExecutionDescription } from "@temporalio/client";
import { z } from "zod";
import type { RecordAuditFromRequestInput } from "../../../lib/audit";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";

export const agentPreviewIdentitySchema = z.strictObject({
	workflowId: z.string().min(1).max(200),
	runId: z.uuid().optional(),
});
export type AgentPreviewAudit = (event: RecordAuditFromRequestInput) => unknown;

import type { AgentPreviewSelectionPolicy } from "./agent-preview-selection-policy";
export interface AgentPreviewResult {
	workflowId: string;
	runId: string;
	draftHash: string;
	state: AgentPreviewState;
}
const previewStateSchema = z.strictObject({
	status: z.enum(["RUNNING", "COMPLETED", "FAILED", "CANCELLED"]),
	phase: z.string(),
	response: z.string().optional(),
	error: z.string().optional(),
	draftHash: z.string().regex(/^[a-f0-9]{64}$/),
	toolCalls: z.array(
		z.strictObject({
			id: z.string(),
			name: z.string(),
			status: z.enum(["success", "error"]),
			durationMs: z.number(),
			message: z.string().optional(),
		}),
	),
	sources: z.array(
		z.strictObject({
			id: z.string(),
			title: z.string(),
			kind: z.string(),
			revision: z.string().optional(),
			truncated: z.boolean().optional(),
		}),
	),
});

async function access(
	actor: AgentPreviewActor,
	draft: z.infer<typeof agentPreviewDraftSchema>,
) {
	try {
		await assertAgentPreviewAccess(actor, draft);
	} catch (error) {
		if (error instanceof AgentPreviewAccessError) {
			throw new ORPCError(error.code, { message: error.message });
		}
		throw error;
	}
}
function unavailable(): never {
	throw new ORPCError("SERVICE_UNAVAILABLE", {
		message:
			"Preview state could not be confirmed. Retry with the same preview identity or idempotency key.",
	});
}

async function resolve(
	actor: AgentPreviewActor,
	raw: unknown,
	selectionPolicy?: AgentPreviewSelectionPolicy,
	admittedRequest?: AgentPreviewRequest,
) {
	const input = agentPreviewIdentitySchema.parse(raw);
	const key = z.uuid().safeParse(input.workflowId.slice(-36));
	if (
		!key.success ||
		previewWorkflowId(actor, key.data) !== input.workflowId
	) {
		throw new ORPCError("NOT_FOUND", {
			message: "Preview not found or access denied.",
		});
	}
	const client = await getTemporalClient();
	let description: WorkflowExecutionDescription;
	try {
		description = await client.workflow
			.getHandle(input.workflowId, input.runId)
			.describe();
	} catch (error) {
		if (error instanceof Error && error.name === "WorkflowNotFoundError") {
			throw new ORPCError("NOT_FOUND", {
				message: "Preview not found or access denied.",
			});
		}
		return unavailable();
	}
	const memo = description.memo?.fabricAgentPreview;
	const parsed = z
		.strictObject({
			version: z.literal(1),
			userId: z.string(),
			organizationId: z.string(),
			draftHash: z.string().regex(/^[a-f0-9]{64}$/),
		})
		.safeParse(memo);
	if (
		description.type !== AGENT_PREVIEW_WORKFLOW ||
		!parsed.success ||
		parsed.data.userId !== actor.userId ||
		parsed.data.organizationId !== actor.organizationId ||
		(input.runId && description.runId !== input.runId)
	) {
		throw new ORPCError("NOT_FOUND", {
			message: "Preview not found or access denied.",
		});
	}
	let request: AgentPreviewRequest;
	if (admittedRequest) {
		if (previewRequestHash(admittedRequest) !== parsed.data.draftHash) {
			throw new ORPCError("CONFLICT", {
				message:
					"This idempotency key belongs to a different preview. Use a new key for a changed draft, prompt or conversation.",
			});
		}
		request = admittedRequest;
	} else {
		try {
			// fetchHistory follows every page. Only the first Started event is needed here.
			const page = await client.workflow.withDeadline(
				Date.now() + 10_000,
				() =>
					client.workflow.workflowService.getWorkflowExecutionHistory(
						{
							namespace: client.workflow.options.namespace,
							execution: {
								workflowId: input.workflowId,
								runId: description.runId,
							},
							maximumPageSize: 1,
							waitNewEvent: false,
							skipArchival: true,
						},
					),
			);
			const started =
				page.history?.events?.[0]
					?.workflowExecutionStartedEventAttributes;
			if (
				started?.workflowType?.name !== AGENT_PREVIEW_WORKFLOW ||
				started.input?.payloads?.length !== 1
			) {
				unavailable();
			}
			const converter = client.workflow.options.loadedDataConverter;
			// Offloaded payloads need the SDK's storage resolver, not a hand-decoded reference.
			if (converter.externalStorage) {
				unavailable();
			}
			const context = {
				type: "workflow" as const,
				namespace: client.workflow.options.namespace,
				workflowId: input.workflowId,
			};
			let payloads = started.input.payloads;
			const boundPayloads = () => {
				const bytes = payloads.reduce(
					(sum, payload) =>
						sum +
						(payload.data?.byteLength ?? 0) +
						Object.entries(payload.metadata ?? {}).reduce(
							(size, [key, value]) =>
								size +
								Buffer.byteLength(key) +
								value.byteLength,
							0,
						),
					0,
				);
				if (
					payloads.length !== 1 ||
					bytes > AGENT_PREVIEW_MAX_BYTES + 8192
				) {
					unavailable();
				}
			};
			boundPayloads();
			for (const codec of [...converter.payloadCodecs].reverse()) {
				payloads = await codec.decode(payloads, context);
				boundPayloads();
			}
			const payload = payloads[0];
			if (!payload) {
				unavailable();
			}
			const decoded: unknown = converter.payloadConverter.fromPayload(
				payload,
				context,
			);
			if (
				Buffer.byteLength(JSON.stringify(decoded) ?? "") >
				AGENT_PREVIEW_MAX_BYTES + 8192
			) {
				unavailable();
			}
			const snapshot = z
				.strictObject({
					actor: z.strictObject({
						userId: z.string(),
						organizationId: z.string(),
					}),
					request: agentPreviewStartSchema,
					draftHash: z.string(),
				})
				.parse(decoded);
			if (
				snapshot.actor.userId !== actor.userId ||
				snapshot.actor.organizationId !== actor.organizationId ||
				snapshot.draftHash !== parsed.data.draftHash ||
				previewRequestHash(snapshot.request) !==
					parsed.data.draftHash ||
				previewWorkflowId(actor, snapshot.request.idempotencyKey) !==
					input.workflowId
			) {
				throw new ORPCError("NOT_FOUND", {
					message: "Preview not found or access denied.",
				});
			}
			request = snapshot.request;
		} catch (error) {
			if (error instanceof ORPCError) {
				throw error;
			}
			unavailable();
		}
	}
	await selectionPolicy?.(request.draft);
	await access(actor, request.draft);
	return {
		description,
		memo: parsed.data,
		request,
		handle: client.workflow.getHandle(input.workflowId, description.runId),
		input,
	};
}

/** A preview is a separate bounded workflow, never a saved-agent mutation or saved run. */
export async function startAgentPreviewCommand(
	actor: AgentPreviewActor,
	raw: unknown,
	audit: AgentPreviewAudit,
	selectionPolicy?: AgentPreviewSelectionPolicy,
): Promise<AgentPreviewResult> {
	if (
		Buffer.byteLength(JSON.stringify(raw) ?? "") > AGENT_PREVIEW_MAX_BYTES
	) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Preview context exceeds the 128 KiB request limit.",
		});
	}
	const request = agentPreviewStartSchema.parse(raw);
	if (Buffer.byteLength(JSON.stringify(request)) > AGENT_PREVIEW_MAX_BYTES) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Preview context exceeds the 128 KiB request limit.",
		});
	}
	await selectionPolicy?.(request.draft);
	await access(actor, request.draft);
	const draftHash = previewRequestHash(request);
	const workflowId = previewWorkflowId(actor, request.idempotencyKey);
	const client = await getTemporalClient();
	try {
		await client.workflow.start(
			AGENT_PREVIEW_WORKFLOW,
			withCorrelationMemo({
				workflowId,
				taskQueue: "agents",
				workflowExecutionTimeout: "5 minutes",
				workflowIdReusePolicy: "REJECT_DUPLICATE",
				workflowIdConflictPolicy: "USE_EXISTING",
				args: [{ actor, request, draftHash }],
				memo: {
					fabricAgentPreview: {
						version: 1,
						...actor,
						draftHash,
					},
				},
			}),
		);
	} catch (error) {
		if (
			!(
				error instanceof Error &&
				error.name === "WorkflowExecutionAlreadyStartedError"
			)
		) {
			unavailable();
		}
	}
	const owned = await resolve(
		actor,
		{ workflowId },
		selectionPolicy,
		request,
	);
	if (owned.memo.draftHash !== draftHash) {
		throw new ORPCError("CONFLICT", {
			message:
				"This idempotency key belongs to a different preview. Use a new key for a changed draft, prompt or conversation.",
		});
	}
	await audit({
		action: "org.agent_preview.started",
		organizationId: actor.organizationId,
		resource: { type: "agent_preview", id: workflowId },
		metadata: { runId: owned.description.runId, draftHash },
	});
	try {
		return await readPreviewState(actor, owned);
	} catch (error) {
		// A newly admitted workflow may not have installed its query handler yet.
		// Keep the verified identity so the caller can poll the same run.
		if (
			!(error instanceof ORPCError) ||
			error.code !== "SERVICE_UNAVAILABLE" ||
			owned.description.status.name !== "RUNNING"
		) {
			throw error;
		}
		await access(actor, request.draft);
		return {
			workflowId,
			runId: owned.description.runId,
			draftHash,
			state: {
				status: "RUNNING",
				phase: "Preparing",
				toolCalls: [],
				sources: [],
				draftHash,
			},
		};
	}
}

export async function getAgentPreviewCommand(
	actor: AgentPreviewActor,
	raw: unknown,
	selectionPolicy?: AgentPreviewSelectionPolicy,
): Promise<AgentPreviewResult> {
	const owned = await resolve(actor, raw, selectionPolicy);
	return readPreviewState(actor, owned);
}
/** Internal provenance for saving a completed preview as a reusable test.
 * This deliberately keeps the same receipt, current-access and draft-hash checks
 * as reading Preview; it is not an alternate public read surface.
 */
export async function getCompletedAgentPreviewTestSource(
	actor: AgentPreviewActor,
	raw: unknown,
	selectionPolicy?: AgentPreviewSelectionPolicy,
) {
	const owned = await resolve(actor, raw, selectionPolicy);
	const result = await readPreviewState(actor, owned);
	if (result.state.status !== "COMPLETED") {
		throw new ORPCError("CONFLICT", {
			message: "Wait for a completed preview before saving it as a test.",
		});
	}
	return owned.request.draft;
}
async function readPreviewState(
	actor: AgentPreviewActor,
	owned: Awaited<ReturnType<typeof resolve>>,
): Promise<AgentPreviewResult> {
	let state: AgentPreviewState;
	try {
		state = await owned.handle.query<AgentPreviewState>("previewState");
	} catch {
		if (owned.description.status.name === "COMPLETED") {
			state = (await owned.handle.result()) as AgentPreviewState;
		} else if (
			["FAILED", "TIMED_OUT", "TERMINATED", "CANCELLED"].includes(
				owned.description.status.name,
			)
		) {
			state = {
				status:
					owned.description.status.name === "CANCELLED"
						? "CANCELLED"
						: "FAILED",
				phase: "Finished",
				error: "Preview stopped before a result was available. You can start another preview.",
				toolCalls: [],
				sources: [],
				draftHash: owned.memo.draftHash,
			};
		} else {
			return unavailable();
		}
	}
	await access(actor, owned.request.draft);
	const parsedState = previewStateSchema.safeParse(state);
	if (!parsedState.success) {
		unavailable();
	}
	state = parsedState.data;
	if (state.draftHash !== owned.memo.draftHash) {
		unavailable();
	}
	// The engine's terminal status wins over a last query snapshot recorded before termination.
	if (
		["FAILED", "TIMED_OUT", "TERMINATED", "CANCELLED"].includes(
			owned.description.status.name,
		)
	) {
		state = {
			...state,
			status:
				owned.description.status.name === "CANCELLED"
					? "CANCELLED"
					: "FAILED",
			phase: "Finished",
		};
	}
	return {
		workflowId: owned.input.workflowId,
		runId: owned.description.runId,
		draftHash: owned.memo.draftHash,
		state,
	};
}

export async function cancelAgentPreviewCommand(
	actor: AgentPreviewActor,
	raw: unknown,
	audit: AgentPreviewAudit,
	selectionPolicy?: AgentPreviewSelectionPolicy,
) {
	const owned = await resolve(actor, raw, selectionPolicy);
	const requested = owned.description.status.name === "RUNNING";
	if (requested) {
		await access(actor, owned.request.draft);
		await owned.handle.cancel();
		await audit({
			action: "org.agent_preview.cancel_requested",
			organizationId: actor.organizationId,
			resource: { type: "agent_preview", id: owned.input.workflowId },
			metadata: { runId: owned.description.runId },
		});
	}
	return {
		workflowId: owned.input.workflowId,
		runId: owned.description.runId,
		requested,
	};
}
