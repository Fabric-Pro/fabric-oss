/**
 * Proposal admission keeps uploads and an already-open migration on their
 * existing paths. Ordinary repository projects now read Git directly, so a
 * new Fabric proposal or direct commit must stop before repository/snapshot
 * work begins.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	getProjectInstructionSettings: vi.fn(),
	getInstructionRepositorySyncForProposal: vi.fn(),
	getPublishedInstructionSnapshot: vi.fn(),
	getMemberProposalBranch: vi.fn(),
	projectFindFirst: vi.fn(),
	mailFrom: "",
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		db: {
			project: {
				findFirst: (...args: unknown[]) => m.projectFindFirst(...args),
			},
		},
		getProjectInstructionSettings: (...args: unknown[]) =>
			m.getProjectInstructionSettings(...args),
		getInstructionRepositorySyncForProposal: (...args: unknown[]) =>
			m.getInstructionRepositorySyncForProposal(...args),
		getPublishedInstructionSnapshot: (...args: unknown[]) =>
			m.getPublishedInstructionSnapshot(...args),
		getMemberProposalBranch: (...args: unknown[]) =>
			m.getMemberProposalBranch(...args),
	};
});
vi.mock("@repo/config", () => ({
	config: {
		mails: {
			get from() {
				return m.mailFrom;
			},
		},
	},
}));

import {
	admitInstructionProposal,
	uploadStartedAuditTemplate,
} from "../proposal-admission";

const PROJECT = "proj_1";
const ORG = "org_1";
const USER = "user_1";
const SHA = "a".repeat(40);
const NOREPLY = ["noreply", "example.com"].join("@");

function syncRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "sync_1",
		projectId: PROJECT,
		organizationId: ORG,
		userId: USER,
		repositoryIntegrationId: "int_1",
		ref: "main",
		rootPath: "instructions",
		generation: 4,
		repositoryIntegration: {
			id: "int_1",
			projectId: PROJECT,
			status: "ACTIVE",
			provider: "GITHUB",
			repositoryUrl: "https://github.com/example-org/example-repo",
		},
		...overrides,
	};
}

function admit(overrides: Record<string, unknown> = {}) {
	return admitInstructionProposal({
		projectId: PROJECT,
		organizationId: ORG,
		userId: USER,
		mode: "proposal",
		proposerName: "Pat Example",
		fileCount: 2,
		...overrides,
	} as Parameters<typeof admitInstructionProposal>[0]);
}

async function refusal(promise: Promise<unknown>) {
	return promise.then(
		() => {
			throw new Error("expected a refusal");
		},
		(error: unknown) =>
			error as { code: string; data?: Record<string, unknown> },
	);
}

beforeEach(() => {
	for (const fn of Object.values(m)) {
		if (typeof fn === "function" && "mockReset" in fn) {
			(fn as ReturnType<typeof vi.fn>).mockReset();
		}
	}
	m.mailFrom = `Fabric <${NOREPLY}>`;
	m.getProjectInstructionSettings.mockResolvedValue({
		ignoreGlobs: null,
		sourceOfTruth: "REPOSITORY",
		migration: null,
	});
	m.getInstructionRepositorySyncForProposal.mockResolvedValue(syncRow());
	m.projectFindFirst.mockResolvedValue({ name: "Example Project" });
});

describe("ordinary direct repository projects", () => {
	it.each(["proposal", "publish", "direct", "commit"] as const)(
		"refuses a new %s before repository or snapshot reads",
		async (mode) => {
			const error = await refusal(
				admit({ mode, message: "Update the instructions" }),
			);

			expect(error).toMatchObject({
				code: "PRECONDITION_FAILED",
				data: { reason: "REPOSITORY_DIRECT_READ" },
			});
			expect(
				m.getInstructionRepositorySyncForProposal,
			).not.toHaveBeenCalled();
			expect(m.getPublishedInstructionSnapshot).not.toHaveBeenCalled();
		},
	);
});

describe("uploads", () => {
	beforeEach(() => {
		m.getProjectInstructionSettings.mockResolvedValue({
			ignoreGlobs: null,
			sourceOfTruth: "UPLOAD",
			migration: null,
		});
	});

	it("keeps proposal notes on the Fabric admission path", async () => {
		await expect(
			admit({
				note: { title: "Tighten the review skill", body: "Why: flaky" },
			}),
		).resolves.toEqual({
			destination: "FABRIC",
			note: { title: "Tighten the review skill", body: "Why: flaky" },
		});
		expect(
			m.getInstructionRepositorySyncForProposal,
		).not.toHaveBeenCalled();
	});

	it("continues to refuse a direct repository commit", async () => {
		const error = await refusal(
			admit({ mode: "commit", message: "Update the instructions" }),
		);

		expect(error).toMatchObject({
			code: "PRECONDITION_FAILED",
			data: { reason: "NOT_REPOSITORY_SOURCED" },
		});
	});
});

describe("an open upload-to-repository migration", () => {
	const pointer = {
		v: 1,
		state: "PROPOSING",
		branchId: "branch_1",
		snapshotId: "snap_move",
		syncId: "sync_1",
		pullRequestUrl: null,
		startedAt: "2026-10-03T10:00:00.000Z",
		userId: USER,
	};

	beforeEach(() => {
		m.getProjectInstructionSettings.mockResolvedValue({
			ignoreGlobs: null,
			sourceOfTruth: "UPLOAD",
			migration: pointer,
		});
		m.getInstructionRepositorySyncForProposal.mockResolvedValue(syncRow());
		m.getMemberProposalBranch.mockResolvedValue({
			pullRequestUrl:
				"https://github.com/example-org/example-repo/pull/9",
			pullRequestExternalId: "9",
		});
	});

	it("keeps its admitted migration proposal path without reading a snapshot", async () => {
		const admission = await admit({
			mode: "migration",
			baseCommitSha: SHA,
			fileCount: 12,
		});

		expect(admission).toMatchObject({
			destination: "REPOSITORY",
			syncId: "sync_1",
			syncGeneration: 4,
			note: { title: "Move coding instructions into the repository" },
			context: { baseCommitSha: SHA, rootPath: "instructions" },
		});
		expect(m.getPublishedInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("blocks every other admission until the migration settles", async () => {
		const error = await refusal(admit({ mode: "proposal" }));

		expect(error).toMatchObject({
			code: "CONFLICT",
			data: {
				reason: "MIGRATION_OPEN",
				state: "PROPOSING",
				pullRequest: {
					url: "https://github.com/example-org/example-repo/pull/9",
					externalId: "9",
				},
			},
		});
	});
});

describe("uploadStartedAuditTemplate", () => {
	it("carries request attribution and caller-known metadata", () => {
		const template = uploadStartedAuditTemplate(
			{
				headers: new Headers({
					"x-forwarded-for": "203.0.113.7",
					"user-agent": "vitest",
				}),
				user: { id: USER, email: NOREPLY, name: "Pat Example" },
				session: { id: "sess_1", impersonatedBy: null },
			},
			{
				organizationId: ORG,
				projectId: PROJECT,
				baseSnapshotId: "snap_base",
				baseVersion: 7,
				putCount: 1,
				deleteCount: 2,
				via: "mcp-gateway",
			},
		);

		expect(template).toMatchObject({
			organizationId: ORG,
			projectId: PROJECT,
			userAgent: "vitest",
			metadata: { mode: "proposal", via: "mcp-gateway" },
		});
		expect(template).toHaveProperty("ipAddress");
	});
});
