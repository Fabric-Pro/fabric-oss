/**
 * `upsertDraftProjectByKey` with `expectedPmSelection`: a draft save whose
 * GitLab container instance was bound from an earlier read applies only
 * while the draft still has that PM selection, so a concurrent save that
 * changed the container cannot be paired with the instance this one read.
 *
 * Run with: pnpm --filter @repo/database exec vitest run __tests__/upsert-draft-pm-selection-guard.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { projectFindFirst, projectUpdate, projectCreate, KnownError } =
	vi.hoisted(() => {
		class KnownError extends Error {
			constructor(
				message: string,
				readonly code: string,
			) {
				super(message);
			}
		}
		return {
			projectFindFirst: vi.fn(),
			projectUpdate: vi.fn(),
			projectCreate: vi.fn(),
			KnownError,
		};
	});

vi.mock("../prisma/client", () => ({
	db: {
		project: {
			findFirst: projectFindFirst,
			update: projectUpdate,
			create: projectCreate,
		},
	},
	Prisma: {
		JsonNull: "__JSON_NULL__",
		DbNull: "__DB_NULL__",
		AnyNull: "__ANY_NULL__",
		PrismaClientKnownRequestError: KnownError,
	},
	ProjectMemberRole: { OWNER: "OWNER" },
}));

import {
	PmSelectionChangedError,
	upsertDraftProjectByKey,
} from "../prisma/queries/projects/projects";

const DRAFT = { id: "draft-1", draftKey: "key-1" };
const READ = {
	serverId: "srv-gitlab",
	configId: null,
	containerId: "42",
	additionalContext: { gitlabOrigin: "https://gitlab.com" },
};
const SAVE = {
	draftKey: "key-1",
	name: "Draft",
	userId: "user-1",
	organizationId: "org-1",
	projectManagementAdditionalContext: {
		areaPath: "Team",
		gitlabOrigin: "https://gitlab.com",
	},
};

beforeEach(() => {
	projectFindFirst.mockReset();
	projectUpdate.mockReset();
	projectCreate.mockReset();
});

describe("upsertDraftProjectByKey — expectedPmSelection", () => {
	it("updates the draft only where it still has the selection read", async () => {
		projectFindFirst.mockResolvedValueOnce(DRAFT);
		projectUpdate.mockResolvedValueOnce(DRAFT);

		await upsertDraftProjectByKey({ ...SAVE, expectedPmSelection: READ });

		expect(projectUpdate.mock.calls[0][0].where).toEqual({
			id: "draft-1",
			projectManagementMcpServerId: "srv-gitlab",
			projectManagementMcpConfigId: null,
			projectManagementContainerId: "42",
			projectManagementAdditionalContext: {
				equals: { gitlabOrigin: "https://gitlab.com" },
			},
		});
	});

	it("reports a changed selection as PmSelectionChangedError", async () => {
		projectFindFirst.mockResolvedValueOnce(DRAFT);
		projectUpdate.mockRejectedValueOnce(
			new KnownError("Record to update not found.", "P2025"),
		);

		await expect(
			upsertDraftProjectByKey({ ...SAVE, expectedPmSelection: READ }),
		).rejects.toBeInstanceOf(PmSelectionChangedError);
	});

	it("refuses to save onto a draft created after the caller read none", async () => {
		projectFindFirst.mockResolvedValueOnce(DRAFT);

		await expect(
			upsertDraftProjectByKey({ ...SAVE, expectedPmSelection: null }),
		).rejects.toBeInstanceOf(PmSelectionChangedError);
		expect(projectUpdate).not.toHaveBeenCalled();
	});

	it("stays unconditional when no selection is expected", async () => {
		projectFindFirst.mockResolvedValueOnce(DRAFT);
		projectUpdate.mockResolvedValueOnce(DRAFT);

		await upsertDraftProjectByKey(SAVE);

		expect(projectUpdate.mock.calls[0][0].where).toEqual({ id: "draft-1" });
	});
});
