/**
 * A project setup paused for a ChatGPT plan reset (Fizzy #2770) shares the
 * `agent_task` table with paused document batches. The batch's lost-resume
 * sweep must leave a setup alone; the setup's own sweep fails the run AND
 * closes the project's analysis (only while it is still this setup's) and
 * the documents queued for the resume. Claiming a setup writes no
 * `startedAt`, which `AgentTask` does not have. Run against in-memory tables
 * that apply the same `where`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };

const tables = vi.hoisted(() => ({
	agentTask: new Map<string, Row>(),
	project: new Map<string, Row>(),
	projectDocument: new Map<string, Row>(),
}));

function matches(row: Row, where: Record<string, unknown>): boolean {
	return Object.entries(where).every(([key, condition]) => {
		const value = row[key];
		if (
			condition &&
			typeof condition === "object" &&
			!(condition instanceof Date)
		) {
			const c = condition as {
				in?: unknown[];
				not?: unknown;
				lt?: Date;
				path?: string[];
				equals?: unknown;
			};
			if (c.in) {
				return c.in.includes(value);
			}
			if ("not" in c) {
				return value !== c.not && value !== undefined;
			}
			if (c.lt) {
				return value instanceof Date && value < c.lt;
			}
			if (c.path) {
				return (
					(value as Record<string, unknown> | null)?.[c.path[0]] ===
					c.equals
				);
			}
		}
		return value === condition;
	});
}

vi.mock("../prisma/client", () => {
	const delegateOf = (rows: Map<string, Row>) => ({
		findUnique: async ({ where }: { where: { id: string } }) => {
			const row = rows.get(where.id);
			return row ? { ...row } : null;
		},
		findFirst: async ({ where }: { where: Record<string, unknown> }) => {
			const row = [...rows.values()].find((r) => matches(r, where));
			return row ? { ...row } : null;
		},
		findMany: async ({ where }: { where: Record<string, unknown> }) =>
			[...rows.values()]
				.filter((r) => matches(r, where))
				.map((r) => ({ ...r })),
		updateMany: async ({
			where,
			data,
		}: {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		}) => {
			let count = 0;
			for (const row of rows.values()) {
				if (matches(row, where)) {
					Object.assign(row, data);
					count++;
				}
			}
			return { count };
		},
	});
	return {
		db: {
			agentTask: delegateOf(tables.agentTask),
			project: delegateOf(tables.project),
			projectDocument: delegateOf(tables.projectDocument),
		},
	};
});

import {
	claimBulkRunResume,
	failOverdueBulkRunResumes,
} from "../prisma/queries/bulk-run-pause";
import {
	failOverdueProjectSetupResumes,
	getPausedProjectSetup,
	getProjectSetupRun,
} from "../prisma/queries/project-setup-run";

const NOW = new Date("2026-10-12T12:00:00.000Z");
const HOUR = 60 * 60_000;
const BASE = "existing-setup-project-1-1";

function seedSetup(overrides: Partial<Row> = {}): Row {
	const row: Row = {
		id: "setup-1",
		agentId: "project_setup",
		userId: "user-1",
		organizationId: "org-1",
		input: { projectId: "project-1" },
		status: "WAITING_FOR_PLAN",
		pauseCount: 1,
		resumesAt: new Date(NOW.getTime() - HOUR),
		resumeState: {
			workflowType: "existingProjectSetupWorkflow",
			taskQueue: "project-documents",
			workflowIdBase: BASE,
			input: {
				projectId: "project-1",
				selectedDocumentTypes: ["PRD", "PROPOSAL", "ARCHITECTURE"],
			},
			progress: {
				documents: [{ id: "a" }, { id: "b" }, { id: "c" }],
				finishedDocumentIds: ["a"],
			},
		},
		...overrides,
	};
	tables.agentTask.set(row.id, row);
	return row;
}

beforeEach(() => {
	tables.agentTask.clear();
	tables.project.clear();
	tables.projectDocument.clear();
	tables.project.set("project-1", {
		id: "project-1",
		codeAnalysisStatus: "SCANNING",
		codeAnalysisWorkflowId: BASE,
	});
	tables.projectDocument.set("doc-queued", {
		id: "doc-queued",
		status: "QUEUED",
		workflowId: `${BASE}-resume-1`,
	});
});

describe("failOverdueProjectSetupResumes", () => {
	it("fails the run, the project's analysis and its queued documents", async () => {
		const setup = seedSetup();

		await expect(
			failOverdueProjectSetupResumes({ graceMinutes: 30, now: NOW }),
		).resolves.toBe(1);

		expect(setup).toMatchObject({ status: "FAILED", resumesAt: null });
		expect(tables.project.get("project-1")?.codeAnalysisStatus).toBe(
			"FAILED",
		);
		expect(tables.projectDocument.get("doc-queued")?.status).toBe("FAILED");
	});

	it("leaves a project whose analysis a newer setup owns", async () => {
		seedSetup();
		Object.assign(tables.project.get("project-1") as Row, {
			codeAnalysisWorkflowId: "existing-setup-project-1-2",
		});

		await failOverdueProjectSetupResumes({ graceMinutes: 30, now: NOW });

		expect(tables.project.get("project-1")?.codeAnalysisStatus).toBe(
			"SCANNING",
		);
	});

	it("leaves a setup whose resume is not yet overdue", async () => {
		const setup = seedSetup({
			resumesAt: new Date(NOW.getTime() - 10 * 60_000),
		});

		await expect(
			failOverdueProjectSetupResumes({ graceMinutes: 30, now: NOW }),
		).resolves.toBe(0);
		expect(setup.status).toBe("WAITING_FOR_PLAN");
	});
});

describe("the batch sweep and a paused setup", () => {
	it("does not close a setup: only the setup's own sweep closes its project too", async () => {
		const setup = seedSetup();
		const batch = seedSetup({
			id: "batch-1",
			agentId: "project_document_generator",
		});

		await expect(
			failOverdueBulkRunResumes({
				kind: "DOCUMENT_BATCH",
				graceMinutes: 30,
				now: NOW,
			}),
		).resolves.toBe(1);

		expect(batch.status).toBe("FAILED");
		expect(setup.status).toBe("WAITING_FOR_PLAN");
	});
});

describe("claiming a setup's resume", () => {
	it("writes no startedAt, which AgentTask does not have", async () => {
		const setup = seedSetup({ resumesAt: new Date(NOW.getTime() + HOUR) });

		await expect(
			claimBulkRunResume({
				kind: "PROJECT_SETUP",
				runId: "setup-1",
				pauseCount: 1,
				viaApiOverride: false,
				now: NOW,
			}),
		).resolves.toMatchObject({ workflowIdBase: BASE });
		expect(setup.status).toBe("RUNNING");
		expect(setup).not.toHaveProperty("startedAt");
	});
});

describe("reading a project's setup run", () => {
	it("reports the paused setup and the documents it still has to write", async () => {
		seedSetup();

		await expect(
			getPausedProjectSetup({
				projectId: "project-1",
				organizationId: "org-1",
				userId: "user-1",
			}),
		).resolves.toMatchObject({ id: "setup-1", pendingDocumentCount: 2 });
	});

	it("counts every selected document when it paused before creating them", async () => {
		seedSetup({
			resumeState: {
				workflowIdBase: BASE,
				input: { selectedDocumentTypes: ["PRD", "PROPOSAL"] },
				progress: { backlogDone: true },
			},
		});

		await expect(
			getPausedProjectSetup({
				projectId: "project-1",
				organizationId: "org-1",
				userId: "user-1",
			}),
		).resolves.toMatchObject({ pendingDocumentCount: 2 });
	});

	it("finds no run of another project or another organization", async () => {
		seedSetup();
		const scope = { runId: "setup-1", userId: "user-1" };

		await expect(
			getProjectSetupRun({
				...scope,
				projectId: "project-2",
				organizationId: "org-1",
			}),
		).resolves.toBeNull();
		await expect(
			getProjectSetupRun({
				...scope,
				projectId: "project-1",
				organizationId: "org-2",
			}),
		).resolves.toBeNull();
		await expect(
			getProjectSetupRun({
				...scope,
				projectId: "project-1",
				organizationId: "org-1",
			}),
		).resolves.toEqual(expect.objectContaining({ id: "setup-1" }));
	});
});
