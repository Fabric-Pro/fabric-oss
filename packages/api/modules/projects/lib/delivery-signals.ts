import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { db, isProjectSoftDeleted, type Prisma } from "@repo/database";
import {
	hasPermission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
import { z } from "zod";
import { DELETED_ORGANIZATION_ERROR_CODE } from "../../../lib/deleted-organization";
import { resolveEffectiveProjectPermissions } from "../../../lib/effective-project-permissions";
import {
	assertProjectVisible,
	PROJECT_NOT_FOUND_MESSAGE,
} from "../../../orpc/middleware/project-visibility";
import {
	type DeliverySignalProvider,
	deliverySignalGetInput,
	deliverySignalListInput,
	deliverySignalPage,
	deliverySignalRecord,
} from "./delivery-signal-contracts";

/** Authenticated transport facts, never fields accepted in a product input. */
export interface DeliverySignalActor {
	userId: string;
	/** Present only when the credential was issued for an organization. */
	organizationBinding?: { organizationId: string | null | undefined };
	boundProjectId?: string | null;
}

export function deliverySignalNotFound(): never {
	throw new ORPCError("NOT_FOUND", { message: PROJECT_NOT_FOUND_MESSAGE });
}
export function deliverySignalPermissionDenied(): never {
	throw new ORPCError("FORBIDDEN", {
		message: "Your current access does not permit this operation.",
		data: { code: "INSUFFICIENT_PERMISSION" },
	});
}
export function requireDeliverySignalScopes(
	scopes: readonly string[],
	configuration = false,
) {
	const required = [
		"projects:read",
		"features:read",
		...(configuration ? ["integrations:read"] : []),
	];
	if (
		required.some(
			(scope) => !scopes.includes(scope) && !scopes.includes("*"),
		)
	) {
		throw new ORPCError("FORBIDDEN", {
			message:
				"The credential does not include the required read scopes.",
			data: { code: "INSUFFICIENT_SCOPE" },
		});
	}
}

/** No ambient tenant or organization membership is substituted for project access. */
export async function requireDeliverySignalProjectAccess(
	actor: DeliverySignalActor,
	projectId: string,
) {
	if (!actor.userId) {
		throw new ORPCError("UNAUTHORIZED");
	}
	if (actor.boundProjectId != null && actor.boundProjectId !== projectId) {
		deliverySignalNotFound();
	}
	await assertProjectVisible(projectId, actor.userId);
	const effectiveAccess = await resolveEffectiveProjectPermissions(
		projectId,
		actor.userId,
	);
	if (!effectiveAccess) {
		deliverySignalNotFound();
	}
	const organizationId = effectiveAccess.organizationId;
	if (typeof organizationId !== "string" || !organizationId.trim()) {
		deliverySignalNotFound();
	}
	if (
		actor.organizationBinding &&
		actor.organizationBinding.organizationId !== organizationId
	) {
		deliverySignalNotFound();
	}
	if (await isProjectSoftDeleted(projectId)) {
		deliverySignalNotFound();
	}
	if (effectiveAccess.organizationDeleted) {
		throw new ORPCError("FORBIDDEN", {
			message: "This organization has been deleted",
			data: { errorCode: DELETED_ORGANIZATION_ERROR_CODE },
		});
	}
	if (
		!hasPermission(effectiveAccess.permissions, Permissions.PROJECT_READ) ||
		!hasPermission(effectiveAccess.permissions, Permissions.STORY_READ)
	) {
		deliverySignalPermissionDenied();
	}
	return { projectId, organizationId, userId: actor.userId };
}
export type DeliverySignalProject = Awaited<
	ReturnType<typeof requireDeliverySignalProjectAccess>
>;

export async function requireDeliverySignalIntegrationRead(
	scope: DeliverySignalProject,
) {
	const member = await db.member.findUnique({
		where: {
			organizationId_userId: {
				organizationId: scope.organizationId,
				userId: scope.userId,
			},
		},
		select: { role: true },
	});
	if (
		!member ||
		!hasPermission(
			resolveOrgPermissions(member.role),
			Permissions.INTEGRATION_READ,
		)
	) {
		deliverySignalPermissionDenied();
	}
}

const fallbackSources = [
	"MANUAL",
	"CUSTOM_AGENT",
	"APPROVED_PROPOSAL",
	"AI_UPDATE",
] as const;
export function recordedDeliverySignalProvider(row: {
	source: string;
	reporterSource: string | null;
}): DeliverySignalProvider | null {
	switch (row.source) {
		case "JIRA":
		case "AZURE_DEVOPS":
		case "FIZZY":
		case "SLACK":
			return row.source;
	}
	if (
		fallbackSources.some((source) => source === row.source) &&
		(row.reporterSource === "SLACK" || row.reporterSource === "TEAMS")
	) {
		return row.reporterSource;
	}
	return null;
}
export function deliverySignalProviderWhere(
	source: DeliverySignalProvider,
): Prisma.UserStoryWhereInput {
	if (source === "TEAMS") {
		return {
			source: { in: [...fallbackSources] },
			reporterSource: "TEAMS",
		};
	}
	if (source === "SLACK") {
		return {
			OR: [
				{ source: "SLACK" },
				{
					source: { in: [...fallbackSources] },
					reporterSource: "SLACK",
				},
			],
		};
	}
	return { source };
}

/** Shared minimized select: neither detail nor pagination loads source bodies or proposals. */
export const deliverySignalSelect = {
	id: true,
	identifier: true,
	title: true,
	source: true,
	reporterSource: true,
	draftingStage: true,
	createdAt: true,
} as const satisfies Prisma.UserStorySelect;
type SelectedRecord = Prisma.UserStoryGetPayload<{
	select: typeof deliverySignalSelect;
}>;

export function deliverySignalWhere(
	scope: DeliverySignalProject,
	source?: DeliverySignalProvider,
	search = "",
): Prisma.UserStoryWhereInput {
	return {
		projectId: scope.projectId,
		project: { organizationId: scope.organizationId, deletedAt: null },
		draftingStage: { not: "DECLINED" },
		AND: [
			source
				? deliverySignalProviderWhere(source)
				: {
						OR: [
							"SLACK",
							"TEAMS",
							"JIRA",
							"AZURE_DEVOPS",
							"FIZZY",
						].map((value) =>
							deliverySignalProviderWhere(
								value as DeliverySignalProvider,
							),
						),
					},
			...(search
				? [
						{
							OR: [
								{
									title: {
										contains: search,
										mode: "insensitive" as const,
									},
								},
								{
									identifier: {
										contains: search,
										mode: "insensitive" as const,
									},
								},
							],
						},
					]
				: []),
		],
	};
}
async function workItemBasePath(scope: DeliverySignalProject) {
	const project = await db.project.findFirst({
		where: {
			id: scope.projectId,
			organizationId: scope.organizationId,
			deletedAt: null,
		},
		select: { organization: { select: { slug: true } } },
	});
	if (!project?.organization) {
		deliverySignalNotFound();
	}
	if (!project.organization.slug?.trim()) {
		throw new ORPCError("CONFLICT", {
			message:
				"This organization's workspace address is unavailable. Contact your workspace owner.",
			data: { code: "ORGANIZATION_ROUTE_UNAVAILABLE" },
		});
	}
	return `/app/${encodeURIComponent(project.organization.slug)}/projects/${encodeURIComponent(scope.projectId)}/stories/`;
}
function projectRecord(row: SelectedRecord, basePath: string) {
	const source = recordedDeliverySignalProvider(row);
	if (!source) {
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message: "Project history is temporarily unavailable.",
		});
	}
	return deliverySignalRecord.parse({
		id: row.id,
		identifier: row.identifier,
		title: Array.from(row.title).slice(0, 240).join(""),
		source,
		kind: "PROJECT_WORK_ITEM",
		draftingStage: row.draftingStage,
		createdAt: row.createdAt.toISOString(),
		href: `${basePath}${encodeURIComponent(row.id)}`,
	});
}

const cursorSchema = z.strictObject({
	v: z.literal(1),
	binding: z.string().regex(/^[a-f0-9]{64}$/),
	time: z.iso.datetime(),
	id: z.string().min(1).max(200),
});
function invalidCursor(): never {
	throw new ORPCError("BAD_REQUEST", {
		message: "Invalid cursor. Reload project history.",
	});
}
function cursorBinding(
	scope: DeliverySignalProject,
	source: DeliverySignalProvider | undefined,
	search: string,
) {
	return createHash("sha256")
		.update(
			JSON.stringify([
				1,
				scope.organizationId,
				scope.userId,
				scope.projectId,
				source ?? null,
				search,
				"PROJECT_WORK_ITEM",
				"createdAt:desc,id:desc",
			]),
		)
		.digest("hex");
}
function decodeCursor(raw: unknown, binding: string) {
	if (raw === undefined) {
		return null;
	}
	if (
		typeof raw !== "string" ||
		!raw.length ||
		raw.length > 2048 ||
		!/^[A-Za-z0-9_-]+$/.test(raw)
	) {
		invalidCursor();
	}
	try {
		const bytes = Buffer.from(raw, "base64url");
		if (bytes.toString("base64url") !== raw) {
			invalidCursor();
		}
		const cursor = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
		if (cursor.binding !== binding) {
			invalidCursor();
		}
		return cursor;
	} catch {
		invalidCursor();
	}
}

export async function listDeliverySignals(
	actor: DeliverySignalActor,
	raw: unknown,
) {
	const input = deliverySignalListInput.parse(raw);
	const scope = await requireDeliverySignalProjectAccess(
		actor,
		input.projectId,
	);
	const binding = cursorBinding(scope, input.source, input.search);
	const cursor = decodeCursor(input.cursor, binding);
	const where = deliverySignalWhere(scope, input.source, input.search);
	if (
		cursor &&
		!(await db.userStory.findFirst({
			where: {
				AND: [
					where,
					{ id: cursor.id, createdAt: new Date(cursor.time) },
				],
			},
			select: { id: true },
		}))
	) {
		invalidCursor();
	}
	const rows = await db.userStory.findMany({
		where: cursor
			? {
					AND: [
						where,
						{
							OR: [
								{ createdAt: { lt: new Date(cursor.time) } },
								{
									createdAt: new Date(cursor.time),
									id: { lt: cursor.id },
								},
							],
						},
					],
				}
			: where,
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take: input.limit + 1,
		select: deliverySignalSelect,
	});
	const visible = rows.slice(0, input.limit);
	const last = visible.at(-1);
	const basePath = await workItemBasePath(scope);
	return deliverySignalPage.parse({
		version: 1,
		coverage: "PROJECT_WORK_ITEMS_ONLY",
		items: visible.map((row) => projectRecord(row, basePath)),
		nextCursor:
			rows.length > input.limit && last
				? Buffer.from(
						JSON.stringify({
							v: 1,
							binding,
							time: last.createdAt.toISOString(),
							id: last.id,
						}),
					).toString("base64url")
				: null,
	});
}
export async function getDeliverySignal(
	actor: DeliverySignalActor,
	raw: unknown,
) {
	const input = deliverySignalGetInput.parse(raw);
	const scope = await requireDeliverySignalProjectAccess(
		actor,
		input.projectId,
	);
	const row = await db.userStory.findFirst({
		where: { AND: [deliverySignalWhere(scope), { id: input.id }] },
		select: deliverySignalSelect,
	});
	if (!row) {
		deliverySignalNotFound();
	}
	return projectRecord(row, await workItemBasePath(scope));
}

/** Preserve semantic causes across the native oRPC, REST and MCP envelopes. */
export function deliverySignalErrorCode(error: ORPCError<string, unknown>) {
	const data = error.data;
	if (data && typeof data === "object") {
		if ("code" in data && typeof data.code === "string") {
			return data.code;
		}
		if ("errorCode" in data && typeof data.errorCode === "string") {
			return data.errorCode;
		}
	}
	return error.code;
}
