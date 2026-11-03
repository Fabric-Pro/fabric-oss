/**
 * Importing a project from its repository (specs/2026-10-23-repository-import):
 * the run a person follows as a checklist, what its analysis found, and
 * what the person chose to create. USER_OWNED and
 * project-scoped: writes copy the parent project's tenancy, reads filter by
 * projectId, and callers resolve project access before calling in.
 */

import {
	db,
	type Prisma,
	type ProjectImportRun,
	type ProjectImportRunStatus,
} from "../client";

export const PROJECT_IMPORT_STEPS = [
	"connect",
	"structure",
	"stack",
	"code",
	"docs",
	"classify",
	"summary",
	"documents",
	"context",
	"decisions",
	"backlog",
	"knowledge",
	"instructions",
	"review",
] as const;

export type ProjectImportStepKey = (typeof PROJECT_IMPORT_STEPS)[number];

export type ProjectImportStepStatus =
	| "PENDING"
	| "RUNNING"
	| "DONE"
	| "SKIPPED"
	| "FAILED";

export type ProjectImportStep = {
	key: ProjectImportStepKey;
	status: ProjectImportStepStatus;
	detail?: string;
	startedAt?: string;
	finishedAt?: string;
};

/** Where one repository document goes in Fabric. */
export type ProjectImportDestination =
	| "document"
	| "context"
	| "decision"
	| "backlog"
	| "knowledge"
	| "skip";

export type ProjectImportDocumentFinding = {
	path: string;
	title: string;
	/** What the content looks like (the classifier's kind). */
	kind: string;
	/** For a "document": the Fabric document type. */
	documentType?: string;
	confidence: number;
	reason: string;
	bytes: number;
	/** Where the analysis proposes it goes. */
	destination: ProjectImportDestination;
	/** For "backlog": how many open items it holds. */
	itemCount?: number;
};

export type ProjectImportFindings = {
	repository: {
		provider: string;
		url: string;
		name: string;
		branch: string;
	};
	profile: {
		fileCount: number;
		documentCount: number;
		codeFileCount: number;
		kind: string;
		languages: { name: string; files: number }[];
		topFolders: { name: string; files: number }[];
	};
	stack: { name: string; category: string; evidence: string[] }[];
	summary: {
		description: string;
		goals: string;
		features: string[];
		/** True when a model wrote it; false for the deterministic fallback. */
		generated: boolean;
	};
	documents: ProjectImportDocumentFinding[];
	/** Text documents found but not read (over the cap). */
	unreadDocumentCount: number;
	aiFileCount: number;
	/** Whether the project already has a Living Memory repository sync (the import then copies context once). */
	contextSyncConfigured: boolean;
	/** `owner/name` of the separate repository the project's coding instructions sync from; its AI files are then not offered for moving. Absent on older runs. */
	instructionsRepository?: string | null;
	/** Filled when the selection is applied. */
	applied?: ProjectImportAppliedCounts;
};

export type ProjectImportAppliedCounts = {
	projectFields: boolean;
	documents: number;
	contextPaths: number;
	contextSynced: boolean;
	contexts: number;
	decisions: number;
	backlogProposals: number;
	backlogItems: number;
	knowledge: number;
	failed: number;
};

/** What the person kept from the proposal. */
export type ProjectImportSelection = {
	projectFields: {
		description: boolean;
		goals: boolean;
		techStack: boolean;
		features: boolean;
	};
	documents: { path: string; destination: ProjectImportDestination }[];
};

export async function createProjectImportRun(input: {
	projectId: string;
	userId: string;
	organizationId: string | null;
	repositoryIntegrationId: string;
}): Promise<ProjectImportRun> {
	const now = new Date().toISOString();
	const steps: ProjectImportStep[] = PROJECT_IMPORT_STEPS.map((key) =>
		key === "connect"
			? {
					key,
					status: "DONE",
					detail: "The repository is connected.",
					finishedAt: now,
				}
			: { key, status: "PENDING" },
	);
	return db.projectImportRun.create({
		data: {
			projectId: input.projectId,
			userId: input.userId,
			organizationId: input.organizationId,
			repositoryIntegrationId: input.repositoryIntegrationId,
			steps: steps as unknown as Prisma.InputJsonArray,
		},
	});
}

export async function getProjectImportRun(
	id: string,
	projectId: string,
): Promise<ProjectImportRun | null> {
	return db.projectImportRun.findFirst({ where: { id, projectId } });
}

export async function getLatestProjectImportRun(
	projectId: string,
): Promise<ProjectImportRun | null> {
	return db.projectImportRun.findFirst({
		where: { projectId },
		orderBy: { createdAt: "desc" },
	});
}

/**
 * Sets one step's status and detail, stamping when it started or finished.
 * Read-modify-write in one transaction with the row locked, so two steps
 * recorded at once do not lose each other's update.
 */
export async function updateProjectImportStep(
	id: string,
	projectId: string,
	key: ProjectImportStepKey,
	patch: { status: ProjectImportStepStatus; detail?: string },
): Promise<void> {
	await db.$transaction(async (tx) => {
		await tx.$queryRaw`SELECT 1 FROM "project_import_run" WHERE "id" = ${id} FOR UPDATE`;
		const run = await tx.projectImportRun.findFirst({
			where: { id, projectId },
			select: { steps: true },
		});
		if (!run) {
			return;
		}
		const now = new Date().toISOString();
		const steps = (run.steps as unknown as ProjectImportStep[]).map(
			(step) =>
				step.key !== key
					? step
					: {
							...step,
							status: patch.status,
							...(patch.detail !== undefined
								? { detail: patch.detail }
								: {}),
							...(patch.status === "RUNNING"
								? { startedAt: now }
								: {}),
							...(patch.status === "DONE" ||
							patch.status === "SKIPPED" ||
							patch.status === "FAILED"
								? { finishedAt: now }
								: {}),
						},
		);
		await tx.projectImportRun.update({
			where: { id },
			data: { steps: steps as unknown as Prisma.InputJsonArray },
		});
	});
}

export async function updateProjectImportRun(
	id: string,
	projectId: string,
	data: {
		status?: ProjectImportRunStatus;
		findings?: Prisma.InputJsonValue;
		error?: string | null;
	},
): Promise<void> {
	await db.projectImportRun.updateMany({ where: { id, projectId }, data });
}
