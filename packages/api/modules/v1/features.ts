/**
 * v1 Features routes (UserStory records displayed as Features in the UI)
 * GET /projects/:projectId/features        list features
 * GET /projects/:projectId/features/:id    get feature details
 */
import {
	canCreateProjectStory,
	canUpdateProjectStory,
	createStory,
	getProjectAccessById,
	getStoryById,
	getUserById,
	listStories,
	listTasks,
	updateStory,
} from "@repo/database";
import { logger } from "@repo/logs";
import type { Hono } from "hono";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import { enqueuePmSync } from "../projects/lib/enqueue-pm-sync";
import {
	badRequest,
	forbidden,
	notFound,
	ok,
	resolveV1Context,
} from "./helpers";

export function registerFeatureRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	app.get(
		"/projects/:projectId/features",
		requireScope("features:read"),
		async (c) => {
			const apiCtx = c.get("externalApiContext");
			const ctx = await resolveV1Context(
				apiCtx,
				c.req.query("org"),
				c.req.query("personal") === "1",
			);
			if ("error" in ctx) {
				return c.json({ error: { message: ctx.error } }, ctx.status);
			}

			const projectId = c.req.param("projectId")!;

			// Verify caller can access this project with tenant isolation.
			const project = await getProjectAccessById(
				projectId,
				ctx.userId,
				ctx.organizationId ?? undefined,
			);
			if (!project) {
				return c.json(notFound("Project"), 404);
			}

			const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
			const offset = Number(c.req.query("offset") ?? 0);
			const search = c.req.query("search");
			const priority = c.req.query("priority") as
				| "P0_CRITICAL"
				| "P1_HIGH"
				| "P2_MEDIUM"
				| "P3_LOW"
				| undefined;
			const statusId = c.req.query("statusId");
			const assigneeId = c.req.query("assigneeId");

			const result = await listStories({
				projectId,
				limit,
				offset,
				search,
				priority,
				statusId,
				assigneeId,
			});

			return c.json(ok(result.stories, { total: result.total }));
		},
	);

	app.get(
		"/projects/:projectId/features/:id",
		requireScope("features:read"),
		async (c) => {
			const apiCtx = c.get("externalApiContext");
			const ctx = await resolveV1Context(
				apiCtx,
				c.req.query("org"),
				c.req.query("personal") === "1",
			);
			if ("error" in ctx) {
				return c.json({ error: { message: ctx.error } }, ctx.status);
			}

			const projectId = c.req.param("projectId")!;

			// Verify caller can access this project
			const project = await getProjectAccessById(
				projectId,
				ctx.userId,
				ctx.organizationId ?? undefined,
			);
			if (!project) {
				return c.json(notFound("Project"), 404);
			}

			const story = await getStoryById(c.req.param("id")!, projectId);
			if (!story) {
				return c.json(notFound("Feature"), 404);
			}

			return c.json(ok(story));
		},
	);

	/**
	 * POST /projects/:projectId/features
	 * Creates a new feature (user story) in the project.
	 */
	app.post(
		"/projects/:projectId/features",
		requireScope("features:write"),
		async (c) => {
			const apiCtx = c.get("externalApiContext");
			const ctx = await resolveV1Context(
				apiCtx,
				c.req.query("org"),
				c.req.query("personal") === "1",
			);
			if ("error" in ctx) {
				return c.json({ error: { message: ctx.error } }, ctx.status);
			}

			const projectId = c.req.param("projectId")!;

			// Verify caller can access this project with tenant isolation.
			const project = await getProjectAccessById(
				projectId,
				ctx.userId,
				ctx.organizationId ?? undefined,
			);
			if (!project) {
				return c.json(notFound("Project"), 404);
			}

			// Visibility produced the 404 above; it cannot also stand in for
			// permission. `getProjectAccessById` is true for a Viewer and a
			// Commenter, and creating a feature is a story write — the same
			// question `requireProjectPermission(STORY_CREATE)` asks of the
			// interactive path.
			if (!(await canCreateProjectStory(projectId, ctx.userId))) {
				return c.json(
					forbidden(
						"No permission to create features in this project",
					),
					403,
				);
			}

			let body: {
				title?: string;
				description?: string;
				acceptanceCriteria?: string;
				priority?: string;
			};
			try {
				body = await c.req.json();
			} catch {
				return c.json(badRequest("Invalid JSON body"), 400);
			}

			const title = body.title?.trim();
			if (!title) {
				return c.json(badRequest("title is required"), 400);
			}
			if (title.length > 500) {
				return c.json(
					badRequest("title must be 500 characters or fewer"),
					400,
				);
			}

			const validPriorities = [
				"P0_CRITICAL",
				"P1_HIGH",
				"P2_MEDIUM",
				"P3_LOW",
			] as const;
			const priority = body.priority as
				| (typeof validPriorities)[number]
				| undefined;
			if (priority && !validPriorities.includes(priority)) {
				return c.json(
					badRequest(
						`priority must be one of: ${validPriorities.join(", ")}`,
					),
					400,
				);
			}

			const story = await createStory({
				projectId,
				title,
				description: body.description?.trim(),
				acceptanceCriteria: body.acceptanceCriteria?.trim(),
				priority: priority ?? "P2_MEDIUM",
				createdById: ctx.userId,
				source: "MANUAL",
			});

			return c.json(
				ok({
					id: story.id,
					identifier: story.identifier,
					title: story.title,
					description: story.description ?? null,
					acceptanceCriteria: story.acceptanceCriteria ?? null,
					priority: story.priority,
					projectId: story.projectId,
					assigneeId: story.assigneeId ?? null,
					version: story.version,
					order: story.order,
					createdAt: story.createdAt.toISOString(),
					updatedAt: story.updatedAt.toISOString(),
				}),
				201,
			);
		},
	);

	/**
	 * PATCH /projects/:projectId/features/:id
	 * Updates a feature (user story) in the project.
	 */
	app.patch(
		"/projects/:projectId/features/:id",
		requireScope("features:write"),
		async (c) => {
			const apiCtx = c.get("externalApiContext");
			const ctx = await resolveV1Context(
				apiCtx,
				c.req.query("org"),
				c.req.query("personal") === "1",
			);
			if ("error" in ctx) {
				return c.json({ error: { message: ctx.error } }, ctx.status);
			}

			const projectId = c.req.param("projectId")!;
			const project = await getProjectAccessById(
				projectId,
				ctx.userId,
				ctx.organizationId ?? undefined,
			);
			if (!project) {
				return c.json(notFound("Project"), 404);
			}

			if (!(await canUpdateProjectStory(projectId, ctx.userId))) {
				return c.json(
					forbidden(
						"No permission to update features in this project",
					),
					403,
				);
			}

			const storyId = c.req.param("id")!;
			const story = await getStoryById(storyId, projectId);
			if (!story) {
				return c.json(notFound("Feature"), 404);
			}

			let body: {
				title?: string;
				description?: string | null;
				acceptanceCriteria?: string | null;
				priority?: string;
			};
			try {
				body = await c.req.json();
			} catch {
				return c.json(badRequest("Invalid JSON body"), 400);
			}

			if (body.title !== undefined && !body.title.trim()) {
				return c.json(badRequest("title cannot be empty"), 400);
			}

			const validPriorities = [
				"P0_CRITICAL",
				"P1_HIGH",
				"P2_MEDIUM",
				"P3_LOW",
			] as const;
			if (
				body.priority &&
				!validPriorities.includes(
					body.priority as (typeof validPriorities)[number],
				)
			) {
				return c.json(
					badRequest(
						`priority must be one of: ${validPriorities.join(", ")}`,
					),
					400,
				);
			}

			const actor = await getUserById(ctx.userId);
			const updated = await updateStory(
				storyId,
				projectId,
				{
					title: body.title?.trim(),
					description: body.description,
					acceptanceCriteria: body.acceptanceCriteria,
					priority: body.priority as
						| (typeof validPriorities)[number]
						| undefined,
				},
				{
					userId: ctx.userId,
					organizationId: ctx.organizationId ?? undefined,
					changedBy: ctx.userId,
					lastEditedSource: "MANUAL",
					lastEditedByName: actor?.name ?? null,
				},
			);

			// Mirror update-story.ts: PM-relevant content edits via the
			// public REST API must respect the per-story auto-sync opt-in.
			// Without this, integrators that rename via REST never see the
			// rename appear in Linear/Jira/ADO.
			const touchedPmContent =
				body.title !== undefined ||
				body.description !== undefined ||
				body.acceptanceCriteria !== undefined;
			if (updated.pmAutoSyncEnabled && touchedPmContent) {
				enqueuePmSync({
					itemId: updated.id,
					itemType: "story",
					projectId,
					userId: ctx.userId,
					triggerSource: "manual-edit",
				}).catch((err) => {
					logger.warn("enqueuePmSync failed", {
						storyId: updated.id,
						err: err instanceof Error ? err.message : String(err),
					});
				});
			}

			return c.json(
				ok({
					id: updated.id,
					identifier: updated.identifier,
					title: updated.title,
					description: updated.description ?? null,
					acceptanceCriteria: updated.acceptanceCriteria ?? null,
					priority: updated.priority,
					projectId: updated.projectId,
					assigneeId: updated.assigneeId ?? null,
					version: updated.version,
					order: updated.order,
					createdAt: updated.createdAt.toISOString(),
					updatedAt: updated.updatedAt.toISOString(),
				}),
			);
		},
	);

	/**
	 * GET /projects/:projectId/features/:id/tasks
	 * Lists tasks (sub-items) for a feature.
	 */
	app.get(
		"/projects/:projectId/features/:id/tasks",
		requireScope("features:read"),
		async (c) => {
			const apiCtx = c.get("externalApiContext");
			const ctx = await resolveV1Context(
				apiCtx,
				c.req.query("org"),
				c.req.query("personal") === "1",
			);
			if ("error" in ctx) {
				return c.json({ error: { message: ctx.error } }, ctx.status);
			}

			const projectId = c.req.param("projectId")!;
			const project = await getProjectAccessById(
				projectId,
				ctx.userId,
				ctx.organizationId ?? undefined,
			);
			if (!project) {
				return c.json(notFound("Project"), 404);
			}

			const story = await getStoryById(c.req.param("id")!, projectId);
			if (!story) {
				return c.json(notFound("Feature"), 404);
			}

			const tasks = await listTasks(story.id);

			return c.json(
				ok(
					tasks.map((t) => ({
						id: t.id,
						identifier: t.identifier,
						title: t.title,
						description: t.description ?? null,
						isCompleted: t.isCompleted,
						estimatedHours: t.estimatedHours ?? null,
						agentCompletedAt:
							t.agentCompletedAt?.toISOString() ?? null,
						order: t.order,
						storyId: t.storyId,
						createdAt: t.createdAt.toISOString(),
					})),
					{ total: tasks.length },
				),
			);
		},
	);
}
