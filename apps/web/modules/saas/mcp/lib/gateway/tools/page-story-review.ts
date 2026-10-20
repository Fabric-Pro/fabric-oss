import {
	canUpdateOrganizationFrames,
	db,
	hasProjectAccess,
} from "@repo/database";
import { z } from "zod";
import { sessionMayReachProject } from "../project-binding";
import { errorResult, jsonResult } from "../tool-results";
import { accessibleFrame, frameIdOf, NO_PAGE_OPEN } from "./frame-context";
import type { PlatformToolHandler } from "./tool-family";

type ReviewOperation = "read" | "configure" | "run" | "history";

function storyReviewHandler(operation: ReviewOperation): PlatformToolHandler {
	return async (args, session) => {
		const commands = await import(
			"@repo/api/modules/workflows/lib/workspace-story-review-commands"
		);
		const { WorkflowCommandError } = await import(
			"@repo/api/modules/workflows/lib/workflow-command-context"
		);
		const schema =
			operation === "configure"
				? commands.workspaceStoryReviewEditSchema
				: operation === "run"
					? commands.workspaceStoryReviewRunSchema
					: operation === "history"
						? commands.workspaceStoryReviewHistorySchema
						: commands.workspaceStoryReviewReadSchema;
		const { frameId: _frameId, ...input } = args;
		const parsedFrame = z
			.string()
			.min(1)
			.max(128)
			.optional()
			.safeParse(args.frameId);
		if (!parsedFrame.success || !schema.safeParse(input).success) {
			return errorResult(
				"Pass only frameId, workflowId and the supported review settings for this command.",
			);
		}
		const frameId = frameIdOf(args, session);
		if (!frameId) {
			return errorResult(NO_PAGE_OPEN);
		}
		const frame = await accessibleFrame(frameId, session);
		if (
			!frame ||
			!session.organizationId ||
			frame.organizationId !== session.organizationId ||
			frame.surface !== "workspace" ||
			!frame.projectId
		) {
			return errorResult(
				"Review settings require an accessible Workspace with an attached project.",
			);
		}
		if (
			!sessionMayReachProject(session, frame.projectId) ||
			!(await hasProjectAccess(frame.projectId, session.userId))
		) {
			return errorResult("Project not found or access denied.");
		}
		const project = await db.project.findFirst({
			where: {
				id: frame.projectId,
				organizationId: session.organizationId,
				deletedAt: null,
			},
			select: { id: true },
		});
		if (!project) {
			return errorResult("Project not found or access denied.");
		}
		if (
			frame.userId !== session.userId ||
			(operation === "configure" &&
				!(await canUpdateOrganizationFrames(
					session.userId,
					session.organizationId,
				)))
		) {
			return errorResult(
				"You do not have permission to configure this Workspace's review workflow.",
			);
		}
		const actor = {
			userId: session.userId,
			organizationId: session.organizationId,
		};
		const binding = {
			id: frame.id,
			userId: frame.userId,
			organizationId: session.organizationId,
			projectId: project.id,
		};
		try {
			switch (operation) {
				case "run":
					return jsonResult(
						await commands.runWorkspaceStoryReviewCommand(
							actor,
							{ ...binding, updatedAt: frame.updatedAt },
							commands.workspaceStoryReviewRunSchema.parse(input),
						),
					);
				case "history":
					return jsonResult(
						await commands.listWorkspaceStoryReviewRunsCommand(
							actor,
							{ ...binding, updatedAt: frame.updatedAt },
							commands.workspaceStoryReviewHistorySchema.parse(
								input,
							),
						),
					);
				case "configure": {
					const result =
						await commands.configureWorkspaceStoryReviewCommand(
							actor,
							binding,
							commands.workspaceStoryReviewEditSchema.parse(
								input,
							),
						);
					// Schedule failures can contain provider details; expose the outcome without those details.
					const schedule =
						result.schedule?.outcome === "failed"
							? {
									outcome: "failed",
									reason: "Settings saved, but the schedule could not be synchronized.",
								}
							: result.schedule;
					return jsonResult({ ...result, schedule });
				}
				case "read":
					return jsonResult(
						await commands.getWorkspaceStoryReviewCommand(
							actor,
							binding,
							commands.workspaceStoryReviewReadSchema.parse(input)
								.workflowId,
						),
					);
				default: {
					const exhaustive: never = operation;
					throw new Error(
						`Unsupported review operation: ${exhaustive}`,
					);
				}
			}
		} catch (error) {
			if (error instanceof WorkflowCommandError) {
				return errorResult(error.message, { reason: error.code });
			}
			return errorResult("Review settings are unavailable. Try again.");
		}
	};
}

export const handleGetStoryReview = storyReviewHandler("read");
export const handleConfigureStoryReview = storyReviewHandler("configure");
export const handleRunStoryReview = storyReviewHandler("run");
export const handleListStoryReviewRuns = storyReviewHandler("history");
