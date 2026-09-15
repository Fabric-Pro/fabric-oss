/**
 * List / Get Discovery Runs (plan Slice 4)
 *
 * AUTHORIZATION: requireProjectPermission(STORY_READ). Rows are additionally
 * XOR-filtered on the tenant context so a personal-context request never
 * sees org rows and vice versa.
 */

import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationIdForCaller,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	type DiscoveryRunOutput,
	discoveryRunOutputSchema,
	parseStoredSources,
} from "./lib";

type RunRow = {
	id: string;
	projectId: string;
	storyId: string;
	userId: string;
	organizationId: string | null;
	status: DiscoveryRunOutput["status"];
	sources: unknown;
	documentId: string | null;
	workflowId: string | null;
	error: string | null;
	createdAt: Date;
	updatedAt: Date;
};

async function attachDocuments(rows: RunRow[]): Promise<DiscoveryRunOutput[]> {
	const documentIds = rows
		.map((row) => row.documentId)
		.filter((id): id is string => !!id);
	const documents =
		documentIds.length > 0
			? await db.projectDocument.findMany({
					where: { id: { in: documentIds } },
					select: {
						id: true,
						title: true,
						status: true,
						isActive: true,
					},
				})
			: [];
	const byId = new Map(documents.map((doc) => [doc.id, doc]));
	return rows.map((row) => ({
		...row,
		sources: parseStoredSources(row.sources),
		document: row.documentId ? (byId.get(row.documentId) ?? null) : null,
	}));
}

export const listDiscoveryRunsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/discovery/runs",
		tags: ["Projects", "Features", "Discovery"],
		summary: "List discovery runs for a project or feature",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string().optional(),
			organizationId: z.string().nullable().optional(),
			limit: z.number().int().min(1).max(100).default(20),
		}),
	)
	.output(z.object({ runs: z.array(discoveryRunOutputSchema) }))
	.handler(async ({ input, context }) => {
		const organizationId = await resolveOrganizationIdForCaller(
			input.organizationId,
			context.session,
			context.user.id,
		);
		const rows = await db.discoveryRun.findMany({
			where: {
				projectId: input.projectId,
				organizationId: organizationId ?? null,
				...(input.storyId ? { storyId: input.storyId } : {}),
			},
			orderBy: { createdAt: "desc" },
			take: input.limit,
		});
		return { runs: await attachDocuments(rows) };
	});

export const getDiscoveryRunProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/discovery/runs/{runId}",
		tags: ["Projects", "Features", "Discovery"],
		summary: "Get a discovery run",
	})
	.input(
		z.object({
			projectId: z.string(),
			runId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(discoveryRunOutputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = await resolveOrganizationIdForCaller(
			input.organizationId,
			context.session,
			context.user.id,
		);
		const row = await db.discoveryRun.findFirst({
			where: {
				id: input.runId,
				projectId: input.projectId,
				organizationId: organizationId ?? null,
			},
		});
		if (!row) {
			throw new ORPCError("NOT_FOUND", {
				message: "Discovery run not found",
			});
		}
		const [run] = await attachDocuments([row]);
		return run;
	});
