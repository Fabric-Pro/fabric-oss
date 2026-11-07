import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { Permissions } from "@repo/permissions";
import { z } from "zod";
import type { RecordAuditFromRequestInput } from "../../../lib/audit";
import { cancelCodingRun } from "../procedures/cancel-coding-run";
import { getCodingRunCommand } from "../procedures/get-coding-run";
import {
	codingRunFollowUpInput,
	sendCodingRunFollowUp,
} from "../procedures/send-follow-up";
import { readCodingRunMessages } from "../procedures/session-messages";
import {
	startCodingRun,
	startCodingRunInput,
} from "../procedures/start-coding-run";
import {
	type CodingRunActor,
	requireCodingRunProject,
} from "./commands-access";
import { publicCodingRuns } from "./public-run";

const id = z.string().trim().min(1).max(200);
export const implementationIdentityInput = z.strictObject({
	projectId: id,
	id,
});
export const implementationListInput = z.strictObject({
	projectId: id,
	storyId: id.optional(),
	limit: z.number().int().min(1).max(50).default(20),
	cursor: id.optional(),
});
export const implementationStartInput = startCodingRunInput
	.omit({
		organizationId: true,
		provider: true,
		executionChannel: true,
	})
	.extend({ requestId: z.uuid() })
	.strict();
export const implementationFollowUpInput = codingRunFollowUpInput
	.omit({ organizationId: true })
	.extend({ projectId: id, promptId: z.uuid() })
	.strict();
export type ImplementationAudit = (
	event: RecordAuditFromRequestInput,
) => unknown;

async function ownedProjectRun(
	actor: CodingRunActor,
	input: z.infer<typeof implementationIdentityInput>,
) {
	const organizationId = await requireCodingRunProject(
		actor,
		input.projectId,
		Permissions.AGENT_READ,
	);
	const run = await db.codingRun.findFirst({
		where: {
			id: input.id,
			projectId: input.projectId,
			organizationId,
		},
		select: { id: true },
	});
	if (!run) {
		throw new ORPCError("NOT_FOUND", {
			message: "Implementation session not found.",
		});
	}
}
/** Project-visible outcome only; never provider metadata, work directories, private host links, prompts or event payloads. */
export function implementationProjection(run: {
	id: string;
	projectId: string;
	storyId: string;
	storyTaskId: string | null;
	status: string;
	kind: string;
	createdAt: Date;
	startedAt: Date | null;
	mergedAt: Date | null;
	pullRequestNumber: number | null;
}) {
	return {
		id: run.id,
		projectId: run.projectId,
		storyId: run.storyId,
		taskId: run.storyTaskId,
		status: run.status,
		kind: run.kind,
		createdAt: run.createdAt.toISOString(),
		startedAt: run.startedAt?.toISOString() ?? null,
		mergedAt: run.mergedAt?.toISOString() ?? null,
		pullRequestNumber: run.pullRequestNumber,
		deliveryEvidence: run.mergedAt
			? ("PR_MERGED" as const)
			: run.pullRequestNumber
				? ("PR_OPENED" as const)
				: ("NO_MERGE_EVIDENCE" as const),
		deployment: "UNKNOWN" as const,
		externalAgentCost: "NOT_REPORTED" as const,
	};
}
export async function listImplementationSessions(
	actor: CodingRunActor,
	raw: unknown,
) {
	const input = implementationListInput.parse(raw);
	const organizationId = await requireCodingRunProject(
		actor,
		input.projectId,
		Permissions.AGENT_READ,
	);
	if (
		input.cursor &&
		!(await db.codingRun.findFirst({
			where: {
				id: input.cursor,
				projectId: input.projectId,
				organizationId,
				...(input.storyId ? { storyId: input.storyId } : {}),
			},
			select: { id: true },
		}))
	) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"This cursor is not available in the selected session list.",
		});
	}
	const rows = await db.codingRun.findMany({
		where: {
			projectId: input.projectId,
			organizationId,
			...(input.storyId ? { storyId: input.storyId } : {}),
		},
		take: input.limit + 1,
		...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		select: {
			id: true,
			projectId: true,
			storyId: true,
			storyTaskId: true,
			status: true,
			kind: true,
			createdAt: true,
			startedAt: true,
			mergedAt: true,
			pullRequestNumber: true,
			providerMetadata: true,
		},
	});
	return {
		sessions: (await publicCodingRuns(rows, actor.userId))
			.slice(0, input.limit)
			.map(implementationProjection),
		hasMore: rows.length > input.limit,
		nextCursor:
			rows.length > input.limit ? rows[input.limit - 1]?.id : undefined,
	};
}
export async function getImplementationSession(
	actor: CodingRunActor,
	raw: unknown,
) {
	const input = implementationIdentityInput.parse(raw);
	await ownedProjectRun(actor, input);
	const run = await getCodingRunCommand(actor, {
		id: input.id,
		organizationId: actor.organizationId,
	});
	return implementationProjection(run);
}
export async function startImplementationSession(
	actor: CodingRunActor,
	raw: unknown,
	audit: ImplementationAudit,
) {
	const input = implementationStartInput.parse(raw);
	const organizationId = await requireCodingRunProject(
		actor,
		input.projectId,
		Permissions.AGENT_EXECUTE,
		true,
	);
	await audit({
		action: "project.coding_run.start_requested",
		category: "project",
		organizationId,
		projectId: input.projectId,
		resource: { type: "project", id: input.projectId },
		metadata: {
			requestId: input.requestId,
			storyId: input.storyId,
			taskId: input.taskId ?? null,
		},
	});
	return startCodingRun(actor, {
		...input,
		organizationId: actor.organizationId,
	});
}
export async function cancelImplementationSession(
	actor: CodingRunActor,
	raw: unknown,
	audit: ImplementationAudit,
) {
	const input = implementationIdentityInput.parse(raw);
	await ownedProjectRun(actor, input);
	const organizationId = await requireCodingRunProject(
		actor,
		input.projectId,
		Permissions.AGENT_DELETE,
		true,
	);
	await audit({
		action: "project.coding_run.cancel_requested",
		category: "project",
		organizationId,
		projectId: input.projectId,
		resource: { type: "coding_run", id: input.id },
	});
	return cancelCodingRun(actor, {
		id: input.id,
		organizationId: actor.organizationId,
	});
}
export async function followUpImplementationSession(
	actor: CodingRunActor,
	raw: unknown,
	audit: ImplementationAudit,
) {
	const input = implementationFollowUpInput.parse(raw);
	await ownedProjectRun(actor, input);
	const organizationId = await requireCodingRunProject(
		actor,
		input.projectId,
		Permissions.AGENT_EXECUTE,
		true,
	);
	await audit({
		action: "project.coding_run.follow_up_requested",
		category: "project",
		organizationId,
		projectId: input.projectId,
		resource: { type: "coding_run", id: input.id },
		metadata: { promptId: input.promptId },
	});
	return sendCodingRunFollowUp(
		actor,
		{
			id: input.id,
			message: input.message,
			promptId: input.promptId,
			organizationId: actor.organizationId,
		},
		audit,
	);
}
export async function getImplementationMessages(
	actor: CodingRunActor,
	raw: unknown,
) {
	const input = implementationIdentityInput.parse(raw);
	await ownedProjectRun(actor, input);
	// Canonical reader independently checks the current private/team server grant.
	const result = await readCodingRunMessages(actor, {
		id: input.id,
		organizationId: actor.organizationId,
	});
	return {
		available: result.available,
		messages: result.messages.slice(-40).map((message) => ({
			id: message.id,
			role: message.role,
			content: message.content.slice(0, 16_000),
		})),
		truncated:
			result.messages.length > 40 ||
			result.messages.some((message) => message.content.length > 16_000),
	};
}
