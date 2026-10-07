import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("../prisma/client", () => ({
	db: { project: { findMany: m.findMany } },
}));

import { getInstructionSummariesForProjects } from "../prisma/queries/instruction-discovery";

const snapshot = {
	organizationId: "organization-1",
	status: "READY",
	version: 18,
	fileCount: 20,
	digest: "old-snapshot-digest",
	publishedAt: new Date("2026-10-01"),
};
function project(sourceOfTruth = "REPOSITORY") {
	return {
		id: "project-1",
		organizationId: "organization-1",
		instructionSettings: { sourceOfTruth },
		publishedInstructionSnapshot: snapshot,
		instructionRepositorySync: {
			organizationId: "organization-1",
			ref: "main",
			rootPath: "instructions",
			generation: 7,
			repositoryIntegration: {
				projectId: "project-1",
				provider: "AZURE_DEVOPS",
				repositoryUrl:
					"https://dev.azure.com/example-org/example-project/_git/instructions",
				repositoryOwner: "example-org",
				repositoryName: "instructions",
			},
		},
	};
}
beforeEach(() => {
	vi.resetAllMocks();
	m.findMany.mockResolvedValue([project()]);
});

describe("instruction discovery metadata", () => {
	it("returns repository identity without a historical snapshot digest or content reads", async () => {
		const result = await getInstructionSummariesForProjects(["project-1"]);
		expect(result.get("project-1")).toEqual({
			source: "repository",
			repository: {
				provider: "AZURE_DEVOPS",
				host: "dev.azure.com",
				path: "example-org/example-project/_git/instructions",
				cloneUrl:
					"https://dev.azure.com/example-org/example-project/_git/instructions",
				ref: "main",
				rootPath: "instructions",
				generation: 7,
			},
		});
		expect(m.findMany).toHaveBeenCalledOnce();
		expect(m.findMany.mock.calls[0][0].select).not.toHaveProperty(
			"instructionFiles",
		);
	});
	it.each(["organization", "project", "missing connection"])(
		"never falls back to a snapshot for an invalid %s binding",
		async (binding) => {
			const row = project();
			if (binding === "organization")
				row.instructionRepositorySync.organizationId =
					"other-organization";
			if (binding === "project")
				row.instructionRepositorySync.repositoryIntegration.projectId =
					"other-project";
			m.findMany.mockResolvedValue([
				{
					...row,
					instructionRepositorySync:
						binding === "missing connection"
							? null
							: row.instructionRepositorySync,
				},
			]);
			expect(
				(await getInstructionSummariesForProjects(["project-1"])).get(
					"project-1",
				),
			).toEqual({ source: "repository", repository: null });
		},
	);
	it("retains uploaded ready snapshot metadata", async () => {
		m.findMany.mockResolvedValue([project("UPLOAD")]);
		expect(
			(await getInstructionSummariesForProjects(["project-1"])).get(
				"project-1",
			),
		).toEqual({
			version: 18,
			fileCount: 20,
			digest: snapshot.digest,
			publishedAt: snapshot.publishedAt,
		});
	});
	it("keeps the uploaded snapshot authoritative during a validated migration", async () => {
		const row = project();
		m.findMany.mockResolvedValue([
			{
				...row,
				instructionSettings: {
					sourceOfTruth: "REPOSITORY",
					migration: {
						v: 1,
						state: "SWITCHING",
						syncId: "sync-1",
						userId: "user-1",
						branchId: "branch-1",
						snapshotId: null,
						pullRequestUrl: null,
						startedAt: "2026-10-01T00:00:00.000Z",
					},
				},
			},
		]);
		expect(
			(await getInstructionSummariesForProjects(["project-1"])).get(
				"project-1",
			),
		).toMatchObject({ version: 18, digest: snapshot.digest });
	});
	it.each(["wrong tenant", "not ready", "no digest"])(
		"does not advertise uploaded data with %s",
		async (fault) => {
			m.findMany.mockResolvedValue([
				{
					...project("UPLOAD"),
					publishedInstructionSnapshot: {
						...snapshot,
						organizationId:
							fault === "wrong tenant"
								? "other-organization"
								: snapshot.organizationId,
						status:
							fault === "not ready"
								? "RECEIVING"
								: snapshot.status,
						digest: fault === "no digest" ? null : snapshot.digest,
					},
				},
			]);
			expect(
				(await getInstructionSummariesForProjects(["project-1"])).get(
					"project-1",
				),
			).toBeNull();
		},
	);
	it("does not query for an empty project list", async () => {
		expect(await getInstructionSummariesForProjects([])).toEqual(new Map());
		expect(m.findMany).not.toHaveBeenCalled();
	});
});
