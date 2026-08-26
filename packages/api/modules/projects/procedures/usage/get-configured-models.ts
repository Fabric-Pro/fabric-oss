import { db } from "@repo/database";
import {
	projectScopeSchema,
	projectUsageProcedure,
	USAGE_ROUTE_TAGS,
} from "./shared";

function readModelField(value: unknown): string | null {
	if (!value || typeof value !== "object") {
		return null;
	}
	const v = (value as Record<string, unknown>).model;
	return typeof v === "string" && v.length > 0 ? v : null;
}

export const getConfiguredModelsProcedure = projectUsageProcedure
	.route({
		method: "GET",
		path: "/projects/{projectId}/usage/configured-models",
		tags: [...USAGE_ROUTE_TAGS],
		summary: "Get configured AI provider/models for a project",
		description:
			"Returns the project's configured Weave pattern/shuttle models and implementation provider defaults.",
	})
	.input(projectScopeSchema)
	.handler(async ({ input }) => {
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: {
				implementationDefaultProvider: true,
				implementationDefaultChannel: true,
				weaveConfig: {
					select: {
						patternConfig: true,
						shuttleConfig: true,
					},
				},
			},
		});

		return {
			patternModel: readModelField(project?.weaveConfig?.patternConfig),
			shuttleModel: readModelField(project?.weaveConfig?.shuttleConfig),
			implementationProvider:
				project?.implementationDefaultProvider ?? null,
			implementationChannel:
				project?.implementationDefaultChannel ?? null,
		};
	});
