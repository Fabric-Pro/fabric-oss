/**
 * Publish Frame Step
 *
 * Turns a workflow's result (usually `{{Agent Task.html}}`) into a Fabric
 * frame: a versioned, sandboxed page shown on a project's Artifacts tab.
 *
 * It writes only inside Fabric, but unattended, so every write is re-checked
 * against live permissions and the run's own organization. A retried step
 * reuses the frame its first attempt created, found by (run, node).
 *
 * `new-version` keeps one frame per (workflow, node): its id lives in
 * `Workflow.settings.publishFrameIds[nodeId]` and each run updates that frame.
 * `updateFrame` snapshots the previous content into the frame's edit history
 * itself, so the step writes no history of its own.
 */

import {
	canCreateOrganizationFrames,
	canUpdateOrganizationFrames,
	createFrame,
	db,
	type FrameBlock,
	type FrameRecord,
	findFrameForSourceRun,
	getFrameById,
	projectPlacementRefusal,
	updateFrame,
} from "@repo/database";
import {
	type PublishFrameNodeConfig,
	PublishFrameNodeConfigSchema,
} from "../../../lib/agentic-workflow-preset";
import type { NodeExecutionResult, StepParams } from "../../types";
import {
	PUBLISH_FRAME_IDS_KEY,
	parseWorkflowSettings,
	readPublishFrameIds,
	updateWorkflowSettings,
} from "../workflow-settings";
import { interpolateTemplateWithDiagnostics } from "./utils";

export const PUBLISH_FRAME_MAX_CONTENT_CHARS = 400_000;
const SOURCE_RUN_TYPE = "workflow";
const BLOCK_ID = "content";
const TITLE_MAX_CHARS = 200;

function fail(error: string): NodeExecutionResult {
	return { success: false, error };
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function buildFrameUrl(
	frameId: string,
	organizationId: string,
): Promise<string> {
	const organization = await db.organization.findUnique({
		where: { id: organizationId },
		select: { slug: true },
	});
	return organization?.slug
		? `/app/${organization.slug}/frames/${frameId}`
		: `/app/frames/${frameId}`;
}

async function refusalForProject(
	projectId: string,
	userId: string,
	organizationId: string,
): Promise<string | null> {
	const refusal = await projectPlacementRefusal({
		userId,
		organizationId,
		projectId,
	});
	if (refusal === "not_found") {
		return "The project for this frame does not exist or is not accessible.";
	}
	return refusal === "not_editable"
		? "No permission to add frames to this project."
		: null;
}

async function recordKeptFrame(
	workflowId: string,
	organizationId: string,
	nodeId: string,
	frameId: string,
): Promise<void> {
	await updateWorkflowSettings(
		{ workflowId, organizationId },
		(settings) => ({
			...settings,
			[PUBLISH_FRAME_IDS_KEY]: {
				...readPublishFrameIds(settings),
				[nodeId]: frameId,
			},
		}),
	);
}

async function findKeptFrame(
	workflowId: string,
	nodeId: string,
	userId: string,
	organizationId: string,
	projectId: string | undefined,
): Promise<FrameRecord | null> {
	const workflow = await db.workflow.findFirst({
		where: { id: workflowId, organizationId },
		select: { settings: true },
	});
	const frameId = readPublishFrameIds(
		parseWorkflowSettings(workflow?.settings),
	)[nodeId];
	if (!frameId) {
		return null;
	}
	const frame = await getFrameById({ id: frameId, userId, organizationId });
	return frame && (frame.projectId ?? undefined) === projectId ? frame : null;
}

type FrameWrite =
	| { frame: FrameRecord; action: "created" | "updated" | "unchanged" }
	| { error: string };

/**
 * Brings a frame this workflow already published up to date: nothing when the
 * title and content are the same, otherwise one `updateFrame`, which keeps the
 * previous content in the frame's edit history.
 */
async function updateExistingFrame(input: {
	existing: FrameRecord;
	userId: string;
	organizationId: string;
	projectId: string | undefined;
	title: string;
	description: string | undefined;
	blocks: FrameBlock[];
}): Promise<FrameWrite> {
	const { existing, blocks, ...scope } = input;
	if (
		existing.title === input.title &&
		existing.document.blocks[0]?.content === blocks[0]?.content
	) {
		return { frame: existing, action: "unchanged" };
	}
	if (
		!(await canUpdateOrganizationFrames(input.userId, input.organizationId))
	) {
		return {
			error: "No permission to update frames in this organization.",
		};
	}
	const updated = await updateFrame({ id: existing.id, blocks, ...scope });
	return updated
		? { frame: updated, action: "updated" }
		: { error: "The frame to update no longer exists." };
}

export async function executePublishFrameStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const parsed = PublishFrameNodeConfigSchema.safeParse(params.nodeConfig);
	if (!parsed.success) {
		const issues = parsed.error.issues
			.map(
				(issue) =>
					`${issue.path.join(".") || "config"}: ${issue.message}`,
			)
			.join("; ");
		return fail(`Invalid Publish Frame configuration: ${issues}`);
	}
	const config: PublishFrameNodeConfig = parsed.data;
	const { userId, organizationId, executionId, workflowId, nodeId } = params;

	if (!(organizationId && executionId && nodeId)) {
		return fail(
			"Publish Frame needs an organization and a workflow run to publish into.",
		);
	}
	if (config.mode === "new-version" && !workflowId) {
		return fail(
			"Publish Frame needs its workflow to keep one frame per run.",
		);
	}

	const projectId = config.projectId ?? params.projectId;
	if (config.surface === "artifact" && !projectId) {
		return fail(
			"An artifact needs a project: set one on this node or on the workflow.",
		);
	}

	const content = interpolateTemplateWithDiagnostics(
		config.content,
		params.inputs,
	);
	if (!content.text.trim()) {
		const missing =
			content.unresolved.length > 0
				? ` (nothing found for ${content.unresolved.map((key) => `{{${key}}}`).join(", ")})`
				: "";
		return fail(`Publish Frame has nothing to publish${missing}.`);
	}
	if (content.text.length > PUBLISH_FRAME_MAX_CONTENT_CHARS) {
		return fail(
			`The content is too large to publish as a frame (${content.text.length} characters; the limit is ${PUBLISH_FRAME_MAX_CONTENT_CHARS}).`,
		);
	}

	const title =
		interpolateTemplateWithDiagnostics(config.title, params.inputs)
			.text.trim()
			.slice(0, TITLE_MAX_CHARS) || "Untitled frame";
	const description = config.description
		? interpolateTemplateWithDiagnostics(
				config.description,
				params.inputs,
			).text.trim() || undefined
		: undefined;
	const blocks = [
		{ id: BLOCK_ID, type: config.format, title, content: content.text },
	];

	try {
		if (!(await canCreateOrganizationFrames(userId, organizationId))) {
			return fail("No permission to create frames in this organization.");
		}
		if (projectId) {
			const refusal = await refusalForProject(
				projectId,
				userId,
				organizationId,
			);
			if (refusal) {
				return fail(refusal);
			}
		}

		const createdByThisRun = await findFrameForSourceRun({
			userId,
			organizationId,
			projectId: projectId ?? null,
			sourceRunType: SOURCE_RUN_TYPE,
			sourceRunId: executionId,
			sourceNodeId: nodeId,
		});
		const kept =
			!createdByThisRun && config.mode === "new-version" && workflowId
				? await findKeptFrame(
						workflowId,
						nodeId,
						userId,
						organizationId,
						projectId,
					)
				: null;

		const existing = createdByThisRun ?? kept;
		const written: FrameWrite = existing
			? await updateExistingFrame({
					existing,
					userId,
					organizationId,
					projectId,
					title,
					description,
					blocks,
				})
			: {
					frame: await createFrame({
						userId,
						organizationId,
						projectId,
						title,
						description,
						blocks,
						surface: config.surface,
						sourceRunType: SOURCE_RUN_TYPE,
						sourceRunId: executionId,
						sourceNodeId: nodeId,
					}),
					action: "created",
				};
		if ("error" in written) {
			return fail(written.error);
		}
		const { frame, action } = written;

		if (config.mode === "new-version" && workflowId) {
			await recordKeptFrame(workflowId, organizationId, nodeId, frame.id);
		}

		return {
			success: true,
			output: {
				frameId: frame.id,
				title: frame.title,
				url: await buildFrameUrl(frame.id, organizationId),
				action,
			},
		};
	} catch (error) {
		console.error("[publish-frame] Error:", toErrorMessage(error));
		return fail(`Publish Frame failed: ${toErrorMessage(error)}`);
	}
}
