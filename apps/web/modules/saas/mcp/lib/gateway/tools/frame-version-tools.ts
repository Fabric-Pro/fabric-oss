/**
 * Fabric MCP Gateway - Page version tools
 *
 * Every edit of a page is saved as a version, so a change is never final: the
 * versions can be listed, an earlier one restored by the page's owner, and the
 * page forked by anyone who can open it. Restoring and forking go through the
 * frame service, which holds them to the organization's frame permissions and
 * places the copy; this module adds the page the call means (the open Workspace
 * by default) and the names a fork may be given as tools.
 *
 * The tools' definitions are Fabric's one list
 * (`@repo/temporal/fabric-frame-version-tool-definitions`); this module is their
 * handlers.
 */

import { db, getFrameEditHistory } from "@repo/database";
import { FABRIC_FRAME_VERSION_TOOL_DEFINITIONS } from "@repo/temporal/fabric-frame-version-tool-definitions";
import { errorResult, jsonResult } from "../tool-results";
import type { GatewaySession, ToolCallResult } from "../types";
import {
	accessibleFrame,
	clampLimit,
	frameIdOf,
	NO_PAGE_OPEN,
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

/** See `./frame-tools`: the frame service is loaded on first use. */
const frameService = () => import("@repo/temporal/frame-service");

const DEFAULT_VERSIONS = 50;
const MAX_VERSIONS = 200;

async function handleListFrameVersions(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const frameId = frameIdOf(args, session);
	if (!frameId) {
		return errorResult(NO_PAGE_OPEN);
	}
	if (!(await accessibleFrame(frameId, session))) {
		return errorResult("Frame not found.");
	}

	const [history, total] = await Promise.all([
		getFrameEditHistory(
			frameId,
			clampLimit(args.limit, {
				fallback: DEFAULT_VERSIONS,
				max: MAX_VERSIONS,
			}),
		),
		db.frameEditHistory.count({ where: { frameId } }),
	]);
	const editors = await db.user.findMany({
		where: {
			id: { in: [...new Set(history.map((entry) => entry.editedBy))] },
		},
		select: { id: true, name: true },
	});
	const nameOf = new Map(editors.map((editor) => [editor.id, editor.name]));

	return jsonResult({
		frameId,
		note: "Version N is the page as it was before edit N; restoring it brings that back and keeps the current content as a version.",
		versions: history.map((entry, index) => ({
			version: total - index,
			editType: entry.editType,
			editedBy: {
				id: entry.editedBy,
				name: nameOf.get(entry.editedBy) ?? null,
			},
			editedAt: entry.editedAt.toISOString(),
			...(entry.revertedToVersion === null
				? {}
				: { revertedToVersion: entry.revertedToVersion }),
		})),
	});
}

async function handleRestoreFrameVersion(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const frameId = frameIdOf(args, session);
	if (!frameId) {
		return errorResult(NO_PAGE_OPEN);
	}
	const { restoreFirstClassFrameVersion } = await frameService();
	const result = await restoreFirstClassFrameVersion({
		args: { ...args, frameId },
		userId: session.userId,
		userEmail: session.email,
		organizationId: session.organizationId || undefined,
	});
	return "error" in result
		? errorResult(String(result.error || "Unknown frame error"))
		: jsonResult(await withPageUrl(result, session));
}

function handleDuplicateFrame(
	pageMayDeclare: PageToolValidator,
): PlatformToolHandler {
	return async (args, session) => {
		const frameId = frameIdOf(args, session);
		if (!frameId) {
			return errorResult(NO_PAGE_OPEN);
		}
		const refusal = await runtimeToolsRefusal(
			args,
			pageMayDeclare,
			session,
		);
		if (refusal) {
			return refusal;
		}
		const { duplicateFirstClassFrame } = await frameService();
		const result = await duplicateFirstClassFrame({
			args: { ...args, frameId },
			userId: session.userId,
			userEmail: session.email,
			organizationId: session.organizationId || undefined,
			runtimeTools: args.runtimeTools,
			conversationId: session.actingContext?.conversationId,
			sourceRunType: "MCP_GATEWAY",
			sourceRunId: session.sessionId,
		});
		return "error" in result
			? errorResult(String(result.error || "Unknown frame error"))
			: jsonResult(await withPageUrl(result, session));
	};
}

/** The version tools, registered like every other family (see `./frame-tools`). */
export function createFrameVersionTools(
	pageMayDeclare: PageToolValidator,
): ToolFamily {
	return toolFamily(
		FABRIC_FRAME_VERSION_TOOL_DEFINITIONS,
		new Map<string, PlatformToolHandler>([
			["fabric_list_frame_versions", handleListFrameVersions],
			["fabric_restore_frame_version", handleRestoreFrameVersion],
			["fabric_duplicate_frame", handleDuplicateFrame(pageMayDeclare)],
		]),
	);
}
