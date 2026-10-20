import { db, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import { sessionMayReachProject } from "../project-binding";
import { errorResult, jsonResult } from "../tool-results";
import { accessibleFrame, frameIdOf, NO_PAGE_OPEN } from "./frame-context";
import type { PlatformToolHandler } from "./tool-family";

export const handleGetReviewOptions: PlatformToolHandler = async (
	args,
	session,
) => {
	const { listReviewSelectorOptions, reviewSelectorPageSchema } =
		await import("@repo/api/modules/ai-config/lib/review-selector-options");
	const parsed = reviewSelectorPageSchema
		.extend({ frameId: z.string().min(1).max(128).optional() })
		.strict()
		.safeParse(args);
	if (!parsed.success) {
		return errorResult(
			"Pass only frameId and bounded selector pagination.",
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
		frame.organizationId !== session.organizationId
	) {
		return errorResult("Workspace not found.");
	}
	if (frame.surface !== "workspace" || !frame.projectId) {
		return errorResult(
			"Review options require a Workspace with an attached project.",
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
		select: { id: true, name: true },
	});
	if (!project) {
		return errorResult("Project not found or access denied.");
	}
	try {
		return jsonResult({
			project: { id: project.id, label: project.name.slice(0, 200) },
			...(await listReviewSelectorOptions(
				{
					userId: session.userId,
					organizationId: session.organizationId,
				},
				parsed.data,
			)),
		});
	} catch {
		return errorResult(
			"Review options are unavailable or access is denied.",
		);
	}
};
