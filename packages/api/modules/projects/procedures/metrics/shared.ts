/**
 * Shared pieces for `projects.metrics.*` (plan Slice 8).
 *
 * Tenant identity on a metric row follows the delivery module's
 * `tenantOwnerFor` rule: on an organization project the row carries the
 * actor as `userId` and the project's `organizationId`; on a personal
 * project it carries the owner and `organizationId: null`. Reads filter on
 * `projectId` plus the XOR organization filter so every project member with
 * `PROJECT_READ` sees the same list.
 */
import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { z } from "zod";

export const metricDirectionSchema = z.enum(["UP", "DOWN"]);
export const metricSourceKindSchema = z.enum(["MANUAL", "WEBHOOK"]);

export const METRIC_SELECT = {
	id: true,
	projectId: true,
	name: true,
	description: true,
	direction: true,
	target: true,
	sourceKind: true,
	webhookSecretHash: true,
	lastValue: true,
	previousValue: true,
	lastObservedAt: true,
	createdAt: true,
	updatedAt: true,
} as const;

type MetricRow = {
	id: string;
	projectId: string;
	name: string;
	description: string | null;
	direction: "UP" | "DOWN";
	target: number | null;
	sourceKind: "MANUAL" | "WEBHOOK";
	webhookSecretHash: string | null;
	lastValue: number | null;
	previousValue: number | null;
	lastObservedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
};

export interface ProjectSuccessMetricDto {
	id: string;
	projectId: string;
	name: string;
	description: string | null;
	direction: "UP" | "DOWN";
	target: number | null;
	sourceKind: "MANUAL" | "WEBHOOK";
	/** True when a webhook secret is configured. The hash itself never leaves the server. */
	hasWebhookSecret: boolean;
	lastValue: number | null;
	previousValue: number | null;
	lastObservedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

/** Strips the secret hash — callers never see it, not even hashed. */
export function toMetricDto(row: MetricRow): ProjectSuccessMetricDto {
	const { webhookSecretHash, ...rest } = row;
	return { ...rest, hasWebhookSecret: webhookSecretHash !== null };
}

/** Webhook secret returned exactly once from create / update / rotate. */
export interface ShownOnceSecret {
	value: string;
	/** Always true: the plaintext is not retrievable again; rotate to get a new one. */
	shownOnce: true;
}

export async function loadProjectTenant(projectId: string): Promise<{
	id: string;
	userId: string;
	organizationId: string | null;
}> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { id: true, userId: true, organizationId: true },
	});
	if (!project) {
		throw new ORPCError("NOT_FOUND", { message: "Project not found" });
	}
	return project;
}

/** Row identity for a new metric (see file header). */
export function metricTenantFor(
	project: { userId: string; organizationId: string | null },
	actorUserId: string,
): { userId: string; organizationId: string | null } {
	return project.organizationId
		? { userId: actorUserId, organizationId: project.organizationId }
		: { userId: project.userId, organizationId: null };
}

/** XOR filter for reads and writes scoped to one project. */
export function metricScope(project: {
	id: string;
	organizationId: string | null;
}) {
	return { projectId: project.id, organizationId: project.organizationId };
}

export async function loadMetricOrThrow(
	metricId: string,
	project: { id: string; organizationId: string | null },
) {
	const metric = await db.projectSuccessMetric.findFirst({
		where: { id: metricId, ...metricScope(project) },
		select: METRIC_SELECT,
	});
	if (!metric) {
		throw new ORPCError("NOT_FOUND", { message: "Metric not found" });
	}
	return metric;
}
