/**
 * What the member branch machinery needs to know about a move of uploaded
 * instructions into the repository (Fizzy #2878 §9): the project is still
 * upload-backed while its pull request is being made, yet the move's sync row
 * is a valid destination for it; and that pull request says what it is for.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	getInstructionRepositorySyncForProposal: vi.fn(),
	getProjectInstructionSettings: vi.fn(),
	canCreateProjectInstructions: vi.fn(),
	canReadProjectInstructions: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const real = await importOriginal<typeof import("@repo/database")>();
	return {
		...real,
		getInstructionRepositorySyncForProposal:
			m.getInstructionRepositorySyncForProposal,
		getProjectInstructionSettings: m.getProjectInstructionSettings,
		canCreateProjectInstructions: m.canCreateProjectInstructions,
		canReadProjectInstructions: m.canReadProjectInstructions,
	};
});
vi.mock("@repo/logs", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	assertBranchCreationAllowed,
	renderBranchPresentation,
} from "../src/activities/lib/instruction-branch-support";

const REPOSITORY = {
	provider: "GITHUB" as const,
	owner: "example-org",
	repo: "example-repo",
};

const destination = {
	integrationId: "int_1",
	syncId: "sync_move",
	repositoryKey: "github:example-org/example-repo",
	provider: "GITHUB" as const,
	repository: REPOSITORY,
	targetRef: "main",
	rootPath: ".claude",
};

const branch = {
	projectId: "proj_1",
	organizationId: "org_1",
	userId: "user_1",
};

const pointer = (over: Record<string, unknown> = {}) => ({
	v: 1,
	state: "PROPOSING",
	branchId: "branch_1",
	snapshotId: "snap_move",
	syncId: "sync_move",
	pullRequestUrl: null,
	startedAt: "2026-10-03T10:00:00.000Z",
	userId: "user_1",
	...over,
});

beforeEach(() => {
	vi.clearAllMocks();
	m.getInstructionRepositorySyncForProposal.mockResolvedValue({
		id: "sync_move",
		repositoryIntegrationId: "int_1",
		ref: "main",
		rootPath: ".claude",
		allowReaderProposals: false,
		repositoryIntegration: {
			projectId: "proj_1",
			status: "ACTIVE",
			provider: "GITHUB",
			repositoryUrl: "https://github.com/example-org/example-repo",
		},
	});
	m.canCreateProjectInstructions.mockResolvedValue(true);
	m.canReadProjectInstructions.mockResolvedValue(true);
});

function allow() {
	return assertBranchCreationAllowed({
		branch,
		destination,
		phase: "append",
	});
}

describe("assertBranchCreationAllowed for a move from uploads", () => {
	it("accepts the move's sync row as the destination while the project is still upload-backed", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			sourceOfTruth: "UPLOAD",
			ignoreGlobs: null,
			migration: pointer(),
		});

		await expect(allow()).resolves.toBeUndefined();
	});

	it("refuses an upload-backed project with no move: a branch needs a repository to write", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			sourceOfTruth: "UPLOAD",
			ignoreGlobs: null,
			migration: null,
		});

		await expect(allow()).rejects.toMatchObject({
			code: "CONFIGURATION_CHANGED",
		});
	});

	it("never lends the destination to another sync row", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			sourceOfTruth: "UPLOAD",
			ignoreGlobs: null,
			migration: pointer({ syncId: "sync_other" }),
		});

		await expect(allow()).rejects.toMatchObject({
			code: "CONFIGURATION_CHANGED",
		});
	});

	it("accepts the repository-backed project a merged move became, whatever the pointer says", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			sourceOfTruth: "REPOSITORY",
			ignoreGlobs: null,
			migration: pointer({ state: "SWITCHING" }),
		});

		await expect(allow()).resolves.toBeUndefined();
	});

	it("still checks everything else: a switching move does not make an upload-backed project a destination", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			sourceOfTruth: "UPLOAD",
			ignoreGlobs: null,
			migration: pointer({ state: "SWITCHING" }),
		});

		await expect(allow()).rejects.toMatchObject({
			code: "CONFIGURATION_CHANGED",
		});
	});

	it("still re-reads the member's authority", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			sourceOfTruth: "UPLOAD",
			ignoreGlobs: null,
			migration: pointer(),
		});
		m.canCreateProjectInstructions.mockResolvedValue(false);
		m.canReadProjectInstructions.mockResolvedValue(false);

		await expect(allow()).rejects.toMatchObject({
			code: "PERMISSION_REVOKED",
		});
	});
});

describe("renderBranchPresentation for a move from uploads", () => {
	it("says what the pull request is for, in Fabric's own words", () => {
		const rendered = renderBranchPresentation({
			memberName: "Pat Example",
			projectName: "Example Project",
			migration: true,
		});

		expect(rendered.ok).toBe(true);
		if (!rendered.ok) {
			return;
		}
		expect(rendered.presentation.title).toBe(
			"Move coding instructions into the repository",
		);
		expect(rendered.presentation.body).toMatch(
			/adds the coding instructions this project had uploaded to Fabric/,
		);
		expect(rendered.presentation.body).toMatch(
			/Closing it without merging/,
		);
		expect(rendered.presentation.body).toMatch(
			/Opened from Fabric project Example Project by Pat Example/,
		);
	});

	it("is unchanged for an ordinary member branch", () => {
		const rendered = renderBranchPresentation({
			memberName: "Pat Example",
			projectName: "Example Project",
		});

		expect(rendered.ok && rendered.presentation.title).toBe(
			"Coding instruction changes from Pat Example",
		);
	});

	it("still refuses attribution when a name survives the fallback with a credential", () => {
		const leaked = `${"gh"}${"p_"}${"A".repeat(36)}`;

		const rendered = renderBranchPresentation({
			memberName: `Pat ${leaked}`,
			projectName: "Example Project",
			migration: true,
		});

		// The fallback replaces a token-shaped name, so the text is safe.
		expect(rendered.ok).toBe(true);
		expect(JSON.stringify(rendered)).not.toContain(leaked);
	});
});
