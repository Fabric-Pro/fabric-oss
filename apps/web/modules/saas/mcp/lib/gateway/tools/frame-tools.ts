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

async function handleShareFrame(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { shareFirstClassFrame } = await frameService();
	const result = await shareFirstClassFrame({
		args,
		userId: session.userId,
		organizationId: session.organizationId || undefined,
	});
	return "error" in result
		? errorResult(String(result.error || "Unknown frame error"))
		: jsonResult(result);
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
			["fabric_get_frame", handleGetFrame],
			["fabric_list_frames", handleListFrames],
			["fabric_share_frame", handleShareFrame],
			["fabric_create_slideshow", handleCreateSlideshow],
		]),
	);
}
