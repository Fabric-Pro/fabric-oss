import {
	buildParlumeActionUrl,
	canEditProject,
	db,
	recordAudit,
} from "@repo/database";
import { redactLogText } from "@repo/utils/log-redaction";
import { PARLUME_ACTOR_NAME } from "../lib/fabric-mcp-service-headers";
import { createFabricTool } from "./direct-chat/built-in-tools";
import {
	parlumeActionArguments,
	parlumeActionOutcome,
	parlumeToolFingerprint,
} from "./parlume-action-policy";
import { parlumeActivityLog } from "./parlume-log";
import {
	parlumeChangeDoneText,
	parlumeChangeNotMadeText,
} from "./parlume-proposal";
import { postParlumeMeetingChat } from "./parlume-voice";
import {
	isExecutableAgentTool,
	withAgentToolRuntime,
	withApprovedAgentTool,
} from "./shared/agent-tool-runtime";
import { FABRIC_PLATFORM_CONFIG_ID } from "./shared/fabric-confirmation";
import { loadFabricPlatformTools } from "./shared/fabric-platform-mcp";

type ConfirmedAction = NonNullable<
	Awaited<ReturnType<typeof claimConfirmedAction>>
>;

type PreparedChange =
	| {
			run: (args: Record<string, unknown>) => Promise<unknown>;
			close?: () => Promise<void>;
	  }
	| { refusal: string };

const TOOL_CHANGED =
	"This kind of change changed in Fabric after it was proposed, so it was not made. Ask Parlume again.";
const TOOL_UNAVAILABLE =
	"This kind of change cannot be made from Fabric now, so it was not made.";

/**
 * Claims a confirmed action for this run, once. A run that does not win the
 * claim (another run has it, or the confirmation reopened the proposal after
 * an ambiguous start) gets nothing and does nothing.
 */
async function claimConfirmedAction(actionId: string) {
	const claimed = await db.parlumeAction.updateMany({
		where: { id: actionId, status: "EXECUTING", startedAt: null },
		data: { startedAt: new Date() },
	});
	return claimed.count === 1
		? db.parlumeAction.findFirst({
				where: { id: actionId, status: "EXECUTING" },
			})
		: null;
}

/** The tool as the confirming member gets it now, if it is still the one proposed. */
function checkedTool(
	action: ConfirmedAction,
	tool: unknown,
): ((args: Record<string, unknown>) => Promise<unknown>) | string {
	if (!isExecutableAgentTool(tool)) {
		return TOOL_UNAVAILABLE;
	}
	const fingerprint = parlumeToolFingerprint({
		name: action.toolName,
		description: tool.description,
		inputSchema: tool.inputSchema,
		source: {
			configId: action.toolConfigId,
			originalName: action.toolOriginalName,
		},
	});
	if (fingerprint !== action.toolFingerprint) {
		return TOOL_CHANGED;
	}
	return async (args) =>
		tool.execute(args, {
			toolCallId: `parlume-action-${action.id}`,
			messages: [],
		});
}

/**
 * The proposed tool, built again for the member who confirmed it: Fabric's own
 * tools through Fabric MCP with that member's grant, or the in-process Fabric
 * tool bound to that member. Either way the member's project rights apply.
 */
async function prepareChange(
	action: ConfirmedAction,
	memberId: string,
	actingGrant: string | undefined,
): Promise<PreparedChange> {
	if (action.toolConfigId === FABRIC_PLATFORM_CONFIG_ID) {
		if (!actingGrant) {
			return { refusal: TOOL_UNAVAILABLE };
		}
		const platform = await loadFabricPlatformTools(
			{
				userId: memberId,
				organizationId: action.organizationId,
				actingGrant,
				projectId: action.projectId,
				// Fabric MCP's audit row names Parlume acting for the member.
				surface: "parlume",
				sourceRunType: "parlume-action",
				sourceRunId: action.id,
			},
			{ portal: { offer: true } },
		);
		if (!platform) {
			return { refusal: TOOL_UNAVAILABLE };
		}
		const checked = checkedTool(
			action,
			platform.tools[action.toolOriginalName],
		);
		if (typeof checked === "string") {
			await platform.close();
			return { refusal: checked };
		}
		return {
			// The member's confirmation is the approval the tool's own
			// confirmation gate would ask for.
			run: (args) =>
				platform.callAuthorized(action.toolOriginalName, args),
			close: () => platform.close(),
		};
	}
	if (action.toolConfigId === "builtin") {
		const tools = await createFabricTool(action.toolOriginalName, {
			userId: memberId,
			organizationId: action.organizationId,
			projectId: action.projectId,
			workspaceIds: [],
		});
		const checked = checkedTool(action, tools[action.toolOriginalName]);
		if (typeof checked === "string") {
			return { refusal: checked };
		}
		return {
			run: (args) =>
				withAgentToolRuntime(
					{
						projectScope: {
							projectId: action.projectId,
							userId: memberId,
							organizationId: action.organizationId,
						},
						deferStoryDrafting: true,
						invoke: (invocation) => invocation.execute(),
					},
					() =>
						withApprovedAgentTool(
							{
								configId: action.toolConfigId,
								originalName: action.toolOriginalName,
								userId: memberId,
								organizationId: action.organizationId,
								args,
							},
							() => checked(args),
						),
				),
		};
	}
	return { refusal: TOOL_UNAVAILABLE };
}

function stringField(result: unknown, key: string): string | null {
	if (typeof result !== "object" || result === null || !(key in result)) {
		return null;
	}
	const value: unknown = Reflect.get(result, key);
	return typeof value === "string" && value.trim() !== ""
		? value.trim()
		: null;
}

/**
 * How the chat names a work item: a plain-number identifier reads as
 * "feature 12" with its kind, a prefixed one such as F-231 as it is.
 */
function itemLabel(result: unknown): string | null {
	const identifier = stringField(result, "identifier");
	const kind = stringField(result, "kind");
	if (identifier && kind && /^\d+$/.test(identifier)) {
		return `${kind.toLowerCase()} ${identifier}`;
	}
	return identifier ?? stringField(result, "title");
}

/** The work item a result names, when it has an address to open. */
function createdItem(result: unknown): { label: string; url: string } | null {
	const url = stringField(result, "url");
	if (!url || !/^https:\/\//i.test(url)) {
		return null;
	}
	return { label: itemLabel(result) ?? "the result", url };
}

/** The audit fields of the work item a result names, never its title. */
function createdItemAudit(result: unknown) {
	return createdItem(result)
		? {
				itemId:
					stringField(result, "storyId") ?? stringField(result, "id"),
				itemKind: stringField(result, "kind"),
				itemNumber: stringField(result, "identifier"),
			}
		: {};
}

function failureReason(result: unknown): string {
	const reason =
		stringField(result, "error") ?? stringField(result, "message");
	return reason
		? redactLogText(reason).text
		: "Fabric did not make the change.";
}

/**
 * Tells the meeting what came of a confirmed change, while the meeting goes
 * on. Nothing is spoken.
 */
async function reportToMeeting(
	action: ConfirmedAction,
	memberId: string,
	report:
		| { status: "COMPLETED"; result: unknown }
		| {
				status: "FAILED" | "OUTCOME_UNKNOWN";
				reason: string;
		  },
): Promise<void> {
	const session = await db.parlumeMeetingSession.findFirst({
		where: { id: action.sessionId, status: "ACTIVE" },
		select: { id: true },
	});
	if (!session) {
		return;
	}
	const [member, project, actionUrl] = await Promise.all([
		db.user.findUnique({
			where: { id: memberId },
			select: { name: true },
		}),
		db.project.findUnique({
			where: { id: action.projectId },
			select: { name: true },
		}),
		buildParlumeActionUrl({
			projectId: action.projectId,
			organizationId: action.organizationId,
			actionId: action.id,
		}),
	]);
	const message =
		report.status === "COMPLETED"
			? parlumeChangeDoneText({
					member: member?.name || "A project member",
					tag: action.chatTag,
					summary: action.summary,
					item: createdItem(report.result),
					actionUrl,
				})
			: parlumeChangeNotMadeText({
					tag: action.chatTag,
					summary: action.summary,
					projectName: project?.name ?? "this project",
					reason: report.reason,
					outcomeUnknown: report.status === "OUTCOME_UNKNOWN",
					actionUrl,
				});
	const posted = await postParlumeMeetingChat({
		sessionId: session.id,
		message,
	});
	parlumeActivityLog(posted.sent ? "info" : "warn", "action.reported", {
		sessionId: session.id,
		actionId: action.id,
		status: report.status,
		posted: posted.sent,
	});
}

/**
 * Runs a change a member confirmed in Fabric, as that member, and records how
 * it ended. The confirm procedure moved the action to EXECUTING before this
 * started, and this run claims it before acting, so it runs once. A change
 * whose tool is no longer the one proposed, or that the member may no longer
 * make, is not run.
 */
export async function executeConfirmedParlumeAction(input: {
	actionId: string;
	actingGrant?: string;
}): Promise<void> {
	const action = await claimConfirmedAction(input.actionId);
	const memberId = action?.decidedByUserId;
	if (!action || !memberId) {
		return;
	}
	let report:
		| { status: "COMPLETED"; result: unknown }
		| { status: "FAILED" | "OUTCOME_UNKNOWN"; reason: string };
	let outcome: string;
	const prepared = (await canEditProject(action.projectId, memberId))
		? await prepareChange(action, memberId, input.actingGrant)
		: { refusal: "The member who confirmed it cannot edit this project." };
	if ("refusal" in prepared) {
		report = { status: "FAILED", reason: prepared.refusal };
		outcome = prepared.refusal;
	} else {
		try {
			const result = await prepared.run(
				parlumeActionArguments(action.arguments),
			);
			const status = parlumeActionOutcome(result);
			report =
				status === "COMPLETED"
					? { status, result }
					: {
							status,
							reason:
								status === "FAILED"
									? failureReason(result)
									: "Fabric could not confirm whether the change was made. Check before asking again.",
						};
			outcome = redactLogText(
				JSON.stringify(result) ?? "Completed",
			).text.slice(0, 4_000);
		} catch {
			report = {
				status: "OUTCOME_UNKNOWN",
				reason: "The change was interrupted. Check before asking again.",
			};
			outcome =
				"Execution was interrupted. Verify the destination before trying again; this action will not be retried automatically.";
		} finally {
			await prepared.close?.();
		}
	}
	const recorded = await db.parlumeAction.updateMany({
		where: { id: action.id, status: "EXECUTING" },
		data: { status: report.status, completedAt: new Date(), outcome },
	});
	if (recorded.count > 0) {
		const member = await db.user.findUnique({
			where: { id: memberId },
			select: { email: true },
		});
		// Parlume made, or tried to make, the change for the member who
		// confirmed it. Never the arguments or the outcome text, which can
		// carry meeting content.
		recordAudit({
			action: "project.parlume.action_executed",
			category: "project",
			outcome: report.status === "COMPLETED" ? "success" : "failure",
			actor: {
				type: "agent",
				userId: memberId,
				nameSnapshot: PARLUME_ACTOR_NAME,
				emailSnapshot: member?.email ?? null,
			},
			organizationId: action.organizationId,
			projectId: action.projectId,
			resource: {
				type: "parlume_action",
				id: action.id,
				name: action.summary,
			},
			metadata: {
				status: report.status,
				toolName: action.toolName,
				sessionId: action.sessionId,
				chatTag: action.chatTag,
				invitedBy: action.userId,
				...(report.status === "COMPLETED" &&
					createdItemAudit(report.result)),
			},
		});
	}
	parlumeActivityLog(
		report.status === "COMPLETED" ? "info" : "warn",
		"action.confirmed_run",
		{
			sessionId: action.sessionId,
			actionId: action.id,
			toolName: action.toolName,
			status: report.status,
		},
	);
	await reportToMeeting(action, memberId, report);
}

/** A confirmed change whose run stopped before its outcome was recorded. */
export async function failConfirmedParlumeAction(input: {
	actionId: string;
}): Promise<void> {
	await db.parlumeAction.updateMany({
		where: { id: input.actionId, status: "EXECUTING" },
		data: {
			status: "OUTCOME_UNKNOWN",
			completedAt: new Date(),
			outcome:
				"Execution stopped before its outcome could be verified. Check the destination before trying again.",
		},
	});
}
