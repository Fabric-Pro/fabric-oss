/**
 * Fabric MCP Gateway - Frame tools
 *
 * A Frame is a page the agent writes: HTML, a diagram, a report. Two surfaces
 * show them. A project's Artifacts tab lists the project's frames
 * (`surface: "artifact"`); an organization Workspace is a frame the people of
 * the organization open from the Workspaces page (`surface: "workspace"`). So
 * "put this in my workspace" is `fabric_update_frame` on that frame, and the
 * frame the user has open is the default target.
 *
 * A page on a surface runs in a locked sandbox. Its script reaches Fabric only
 * through `window.fabric`, which asks the host page to call a Fabric tool as the
 * viewer, and only the tools the page declares in `runtimeTools`. That is why
 * the names are checked here, against the tool table, when the page is saved
 * (`./runtime-tools-refusal`), and again on every call a page makes
 * (`../page-call-guard`).
 *
 * The tools' definitions are Fabric's one list
 * (`@repo/temporal/fabric-frame-tool-definitions`); this module is their
 * handlers. Access to frames is decided in the frame service; nothing here
 * widens it. What this module adds is where a new frame goes by default: the
 * project the user is looking at, never one the service has not checked.
 */

import {
	frameExportStartSchema,
	frameRevokeSharingSchema,
	frameShareSchema,
	frameSharingMutationDto,
} from "@repo/api/modules/frames/lib/frame-operation-contracts";
import { FRAME_SURFACES } from "@repo/database";
import { FABRIC_FRAME_TOOL_DEFINITIONS } from "@repo/temporal/fabric-frame-tool-definitions";
import { errorResult, jsonResult } from "../tool-results";
import type { GatewaySession, ToolCallResult } from "../types";
import {
	legacyFrameIdOf,
	nonEmptyString,
	organizationSlug,
	pageUrl,
	withPageUrl,
} from "./frame-context";
import {
	type PageToolValidator,
	runtimeToolsRefusal,
} from "./runtime-tools-refusal";
import {
	type PlatformToolHandler,
	type ToolFamily,
	toolFamily,
} from "./tool-family";

/**
 * The frame service is the one dependency loaded on first use. It reaches the
 * AI SDK and the billing stack, which a gateway answering a project read or a
 * workflow list has no reason to load (nor any test of those to stub); every
 * other import of this module is static.
 */
const frameService = () => import("@repo/temporal/frame-service");

/**
 * Where a new frame goes. A project the caller names wins; otherwise the
 * project the user is looking at, which the frame service still checks like any
 * named project. A Workspace belongs to the organization, so it takes a project
 * only when one is named.
 */
function placementProjectId(
	args: Record<string, unknown>,
	session: GatewaySession,
): string | undefined {
	const named = nonEmptyString(args.projectId);
	if (named || args.surface === "workspace") {
		return named;
	}
	return session.actingContext?.projectId ?? session.projectId ?? undefined;
}

/**
 * A new page goes where the chat was opened from: the Workspaces page makes a
 * Workspace and a project's Artifacts tab an artifact, when the caller names no
 * surface. A chat opened anywhere else leaves it to the caller.
 */
function withDefaultSurface(
	args: Record<string, unknown>,
	session: GatewaySession,
): Record<string, unknown> {
	const surface = session.actingContext?.surface;
	return args.surface === undefined && surface ? { ...args, surface } : args;
}

/** The frame an update or read means when it names none: the open Workspace. */
function withDefaultFrameId(
	args: Record<string, unknown>,
	session: GatewaySession,
): Record<string, unknown> {
	return { ...args, frameId: legacyFrameIdOf(args, session) };
}

/**
 * What a create answers: where the page is, never its content. The agent has
 * just written the content and the database holds it; echoing it back costs
 * the model its tokens, and a long page overruns the Orchestrator's cap on a
 * tool result, which replaces the whole answer and strands the chat without
 * the frame id.
 */
function withoutContent<T extends { content: string }>(
	frame: T,
): Omit<T, "content"> {
	const { content: _content, ...rest } = frame;
	return rest;
}

function handleCreateFrame(
	pageMayDeclare: PageToolValidator,
): PlatformToolHandler {
	return async (requestedArgs, session) => {
		const refusal = await runtimeToolsRefusal(
			requestedArgs,
			pageMayDeclare,
			session,
		);
		if (refusal) {
			return refusal;
		}
		const args = withDefaultSurface(requestedArgs, session);
		const { createFirstClassFrame } = await frameService();
		const result = await createFirstClassFrame({
			args,
			userId: session.userId,
			organizationId: session.organizationId || undefined,
			projectId: placementProjectId(args, session),
			runtimeTools: args.runtimeTools,
			shareScope:
				args.sharedWithOrganization === false ? "PRIVATE" : undefined,
			conversationId: session.actingContext?.conversationId,
			// The generation's usage rows go to the same chat. The worker sends
			// only a route-verified conversation here, and the acting grant
			// binds it (checkActingGrant).
			usageConversationId: session.actingContext?.conversationId,
			sourceRunType: "MCP_GATEWAY",
			sourceRunId: session.sessionId,
		});
		return "error" in result
			? errorResult(String(result.error || "Unknown frame error"))
			: jsonResult(await withPageUrl(withoutContent(result), session));
	};
}

async function handleCreateSlideshow(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { createFirstClassFrame } = await frameService();
	const result = await createFirstClassFrame({
		args: { ...args, kind: "slideshow" },
		userId: session.userId,
		organizationId: session.organizationId || undefined,
		conversationId: session.actingContext?.conversationId,
		usageConversationId: session.actingContext?.conversationId,
		sourceRunType: "MCP_GATEWAY",
		sourceRunId: session.sessionId,
	});
	return "error" in result
		? errorResult(String(result.error || "Unknown frame error"))
		: jsonResult(withoutContent(result));
}

function handleUpdateFrame(
	pageMayDeclare: PageToolValidator,
): PlatformToolHandler {
	return async (args, session) => {
		if (
			typeof args.expectedUpdatedAt !== "string" ||
			!Number.isFinite(Date.parse(args.expectedUpdatedAt))
		) {
			return errorResult(
				"Read the frame and provide its expectedUpdatedAt revision before editing.",
			);
		}
		const refusal = await runtimeToolsRefusal(
			args,
			pageMayDeclare,
			session,
		);
		if (refusal) {
			return refusal;
		}
		const { updateFirstClassFrame } = await frameService();
		const result = await updateFirstClassFrame({
			args: withDefaultFrameId(args, session),
			userId: session.userId,
			organizationId: session.organizationId || undefined,
			runtimeTools: args.runtimeTools,
		});
		return "error" in result
			? errorResult(String(result.error || "Unknown frame error"))
			: jsonResult(await withPageUrl(result, session));
	};
}

async function handleEditFrameBlock(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { editFirstClassFrameBlock } = await frameService();
	const result = await editFirstClassFrameBlock({
		args: withDefaultFrameId(args, session),
		userId: session.userId,
		organizationId: session.organizationId || undefined,
	});
	return "error" in result
		? errorResult(String(result.error || "Unknown frame error"))
		: jsonResult(result);
}

async function handleGetFrame(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { getFirstClassFrame } = await frameService();
	const result = await getFirstClassFrame({
		args: withDefaultFrameId(args, session),
		userId: session.userId,
		userEmail: session.email,
		organizationId: session.organizationId || undefined,
		...(session.pageProjectId !== undefined
			? { projectRestrictionId: session.pageProjectId }
			: {}),
	});
	return "error" in result
		? errorResult(String(result.error || "Unknown frame error"))
		: jsonResult(await withPageUrl(result, session));
}

async function handleListFrames(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const conversationId = nonEmptyString(args.conversationId);
	if (
		args.conversationId !== undefined &&
		(!conversationId || conversationId.length > 200)
	) {
		return errorResult("Provide a valid conversation ID.");
	}
	const limit = args.limit;
	const offset = args.offset === undefined ? 0 : args.offset;
	if (
		(limit !== undefined &&
			(typeof limit !== "number" ||
				!Number.isInteger(limit) ||
				limit < 1 ||
				limit > 200)) ||
		typeof offset !== "number" ||
		!Number.isInteger(offset) ||
		offset < 0
	) {
		return errorResult(
			"Provide an integer limit from 1 to 200 and a non-negative offset.",
		);
	}
	const surface = FRAME_SURFACES.find((value) => value === args.surface);
	if (args.surface !== undefined && !surface) {
		return errorResult(
			`surface must be one of: ${FRAME_SURFACES.join(", ")}.`,
		);
	}
	const projectId =
		nonEmptyString(args.projectId) ??
		(surface === "artifact"
			? (session.actingContext?.projectId ??
				session.projectId ??
				undefined)
			: undefined);
	const { listFirstClassFrames } = await frameService();
	const { frames } = await listFirstClassFrames({
		userId: session.userId,
		organizationId: session.organizationId || undefined,
		surface,
		projectId,
		conversationId,
		limit,
		offset,
		...(session.pageProjectId !== undefined
			? { projectRestrictionId: session.pageProjectId }
			: {}),
	});
	const slug = await organizationSlug(session.organizationId);
	return jsonResult({
		frames: frames.map((frame) => {
			const url = pageUrl(slug, frame);
			return url ? { ...frame, pageUrl: url } : frame;
		}),
	});
}

type FrameOperation =
	| "startExport"
	| "getExport"
	| "cancelExport"
	| "downloadExport"
	| "sharing"
	| "share"
	| "revoke";
function frameOperation(action: FrameOperation): PlatformToolHandler {
	return async (args, session) => {
		const writes =
			action === "startExport" ||
			action === "cancelExport" ||
			action === "share" ||
			action === "revoke";
		const scope = writes ? "frames:write" : "frames:read";
		if (
			!session.organizationId ||
			session.projectId ||
			session.pinnedProjectId ||
			session.pageProjectId
		) {
			return errorResult("An organization connection is required.", {
				code: "FORBIDDEN",
			});
		}
		if (
			session.credential !== "session" &&
			!session.scopes.includes(scope) &&
			!session.scopes.includes("*")
		) {
			return errorResult(`This operation requires ${scope} scope.`, {
				code: "INSUFFICIENT_SCOPE",
			});
		}
		const frameId = nonEmptyString(args.frameId);
		if (!frameId) {
			return errorResult("Provide a frameId.", { code: "BAD_REQUEST" });
		}
		const actor = {
			userId: session.userId,
			organizationId: session.organizationId,
			userEmail: session.email,
		};
		if (
			[
				"startExport",
				"getExport",
				"cancelExport",
				"downloadExport",
			].includes(action)
		) {
			const service = await import(
				"@repo/api/modules/frames/lib/frame-export-service"
			);
			try {
				if (action === "startExport") {
					const { frameId: _, ...raw } = args;
					const input = frameExportStartSchema.safeParse(raw);
					if (!input.success) {
						return errorResult(
							"Provide the reviewed revision, UUID requestId and valid orientation.",
							{ code: "BAD_REQUEST" },
						);
					}
					return jsonResult(
						await service.startFrameExport(actor, {
							frameId,
							...input.data,
						}),
					);
				}
				const exportId = nonEmptyString(args.exportId);
				if (!exportId) {
					return errorResult(
						"Provide the exportId from the start result.",
						{ code: "BAD_REQUEST" },
					);
				}
				const input = { frameId, exportId };
				return jsonResult(
					await (action === "getExport"
						? service.getFrameExport(actor, input)
						: action === "cancelExport"
							? service.cancelFrameExport(actor, input)
							: service.downloadFrameExport(actor, input)),
				);
			} catch (error) {
				return error instanceof service.FrameExportError
					? errorResult(error.message, { code: error.code })
					: errorResult(
							"The export action could not finish. Inspect its state before retrying.",
							{ code: "UNAVAILABLE" },
						);
			}
		}
		const db = await import("@repo/database");
		try {
			const permitted =
				action === "revoke"
					? await db.canDeleteOrganizationFrames(
							actor.userId,
							actor.organizationId,
						)
					: writes
						? await db.canUpdateOrganizationFrames(
								actor.userId,
								actor.organizationId,
							)
						: await db.canReadOrganizationFrames(
								actor.userId,
								actor.organizationId,
							);
			if (!permitted) {
				return errorResult(
					"No permission to inspect or change sharing.",
					{ code: "FORBIDDEN" },
				);
			}
			const frame = await db.getFrameById({ id: frameId, ...actor });
			if (!frame) {
				return errorResult("Frame not found.", { code: "NOT_FOUND" });
			}
			if (action === "sharing") {
				const grants = await db.listSharingGrants(frameId);
				return jsonResult({
					scope: frame.shareScope,
					hasPublicLink: Boolean(frame.isPublic && frame.shareToken),
					updatedAt: frame.updatedAt.toISOString(),
					grants: grants.map((g) => ({
						id: g.id,
						email: g.email,
						invitedAt: g.invitedAt.toISOString(),
					})),
				});
			}
			const { frameId: _, ...raw } = args;
			if (action === "share") {
				const input = frameShareSchema.safeParse(raw);
				if (!input.success) {
					return errorResult(
						"Provide the reviewed revision, sharing scope and valid recipients.",
						{ code: "BAD_REQUEST" },
					);
				}
				const result = await db.shareFrame({
					frameId,
					...actor,
					...input.data,
					expectedUpdatedAt: new Date(input.data.expectedUpdatedAt),
				});
				return result.ok
					? jsonResult(frameSharingMutationDto(result))
					: errorResult(result.message, { code: result.reason });
			}
			const input = frameRevokeSharingSchema.safeParse(raw);
			if (!input.success) {
				return errorResult(
					"Provide a reviewed revision and valid revoke mode.",
					{ code: "BAD_REQUEST" },
				);
			}
			const result = await db.revokeFrameSharing({
				frameId,
				...actor,
				...input.data,
				expectedUpdatedAt: new Date(input.data.expectedUpdatedAt),
			});
			return result.ok
				? jsonResult(frameSharingMutationDto(result))
				: errorResult(result.message, { code: result.reason });
		} catch (error) {
			return error instanceof db.FrameUpdateConflictError
				? errorResult(error.message, { code: "CONFLICT" })
				: errorResult(
						"The sharing action could not finish. Inspect its state before retrying.",
						{ code: "UNAVAILABLE" },
					);
		}
	};
}

/**
 * The frame tools, registered like every other family. `pageMayDeclare` is the
 * table owner's answer to "may a page declare this tool": it knows the whole
 * platform table, which this module is part of and cannot import back.
 */
export function createFrameTools(
	pageMayDeclare: PageToolValidator,
): ToolFamily {
	return toolFamily(
		FABRIC_FRAME_TOOL_DEFINITIONS,
		new Map<string, PlatformToolHandler>([
			["fabric_create_frame", handleCreateFrame(pageMayDeclare)],
			["fabric_update_frame", handleUpdateFrame(pageMayDeclare)],
			["fabric_edit_frame_block", handleEditFrameBlock],
			["fabric_get_frame", handleGetFrame],
			["fabric_list_frames", handleListFrames],
			["fabric_share_frame", frameOperation("share")],
			["fabric_get_frame_sharing", frameOperation("sharing")],
			["fabric_revoke_frame_sharing", frameOperation("revoke")],
			["fabric_start_frame_export", frameOperation("startExport")],
			["fabric_get_frame_export", frameOperation("getExport")],
			["fabric_cancel_frame_export", frameOperation("cancelExport")],
			["fabric_download_frame_export", frameOperation("downloadExport")],
			["fabric_create_slideshow", handleCreateSlideshow],
		]),
	);
}
