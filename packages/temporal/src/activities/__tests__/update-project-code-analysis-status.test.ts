/**
 * A resumed project setup writes the project's analysis status only while the
 * analysis is still its own (Fizzy #2770): a setup started since the pause
 * owns it, and the old resume must never write over it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	update: vi.fn(),
	updateMany: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { project: { update: mocks.update, updateMany: mocks.updateMany } },
	findProjectRepoCredentials: vi.fn(),
	getMcpConfigForTenantAndServer: vi.fn(),
	getMcpServerByKey: vi.fn(),
}));
vi.mock("@repo/database/prisma/queries/projects/context-content-hash", () => ({
	contextContentHashOrNull: vi.fn(),
}));
vi.mock("@repo/integrations/gitlab", () => ({
	findUsableGitLabConnection: vi.fn(),
}));

import { updateProjectCodeAnalysisStatus } from "../code-based-setup";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.updateMany.mockResolvedValue({ count: 0 });
});

describe("updateProjectCodeAnalysisStatus", () => {
	it("writes only while the analysis is the resumed setup's own", async () => {
		await updateProjectCodeAnalysisStatus({
			projectId: "project-1",
			status: "COMPLETED",
			onlyIfWorkflowId: "existing-setup-project-1-1",
		});

		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: {
				id: "project-1",
				codeAnalysisWorkflowId: "existing-setup-project-1-1",
			},
			data: { codeAnalysisStatus: "COMPLETED" },
		});
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("writes unconditionally for the setup that started the analysis", async () => {
		await updateProjectCodeAnalysisStatus({
			projectId: "project-1",
			status: "SCANNING",
			workflowId: "existing-setup-project-1-2",
		});

		expect(mocks.update).toHaveBeenCalledWith({
			where: { id: "project-1" },
			data: {
				codeAnalysisStatus: "SCANNING",
				codeAnalysisWorkflowId: "existing-setup-project-1-2",
			},
		});
		expect(mocks.updateMany).not.toHaveBeenCalled();
	});
});
