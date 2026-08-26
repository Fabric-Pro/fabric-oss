/**
 * Diagram CRUD queries with tenant isolation (XOR pattern).
 */

import { db } from "../client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tenantFilter(userId: string, organizationId?: string | null) {
	return organizationId
		? { organizationId, userId }
		: { organizationId: null, userId };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createDiagram(params: {
	title?: string;
	elements: unknown;
	appState?: unknown;
	checkpointId?: string;
	mcpConfigId?: string;
	userId: string;
	organizationId?: string | null;
	projectId?: string | null;
}) {
	return db.diagram.create({
		data: {
			title: params.title,
			elements: params.elements as any,
			appState: params.appState as any,
			checkpointId: params.checkpointId,
			mcpConfigId: params.mcpConfigId,
			userId: params.userId,
			organizationId: params.organizationId ?? undefined,
			projectId: params.projectId ?? undefined,
		},
	});
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getDiagramById(
	diagramId: string,
	userId: string,
	organizationId?: string | null,
) {
	return db.diagram.findFirst({
		where: {
			id: diagramId,
			...tenantFilter(userId, organizationId),
		},
	});
}

export async function listDiagrams(params: {
	userId: string;
	organizationId?: string | null;
	projectId?: string | null;
}) {
	const where: any = {
		...tenantFilter(params.userId, params.organizationId),
	};
	if (params.projectId) {
		where.projectId = params.projectId;
	}
	return db.diagram.findMany({
		where,
		orderBy: { updatedAt: "desc" },
	});
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateDiagram(params: {
	diagramId: string;
	userId: string;
	organizationId?: string | null;
	title?: string;
	elements?: unknown;
	appState?: unknown;
	checkpointId?: string;
}) {
	const existing = await getDiagramById(
		params.diagramId,
		params.userId,
		params.organizationId,
	);
	if (!existing) {
		throw new Error("Diagram not found");
	}

	const data: any = {};
	if (params.title !== undefined) {
		data.title = params.title;
	}
	if (params.elements !== undefined) {
		data.elements = params.elements;
	}
	if (params.appState !== undefined) {
		data.appState = params.appState;
	}
	if (params.checkpointId !== undefined) {
		data.checkpointId = params.checkpointId;
	}

	return db.diagram.update({
		where: { id: params.diagramId },
		data,
	});
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteDiagram(
	diagramId: string,
	userId: string,
	organizationId?: string | null,
) {
	const existing = await getDiagramById(diagramId, userId, organizationId);
	if (!existing) {
		throw new Error("Diagram not found");
	}
	return db.diagram.delete({ where: { id: diagramId } });
}
