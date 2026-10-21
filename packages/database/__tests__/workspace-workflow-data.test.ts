import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	raw: vi.fn(),
	read: vi.fn(),
	write: vi.fn(),
	transactions: [] as object[],
}));
vi.mock("../prisma/client", () => ({
	db: {
		$transaction: async <T>(body: (tx: object) => Promise<T>) => {
			const tx = { $queryRaw: mocks.raw };
			mocks.transactions.push(tx);
			return body(tx);
		},
	},
}));
vi.mock("../prisma/queries/frame-page-records", () => ({
	getPageRecordWithin: mocks.read,
	setPageRecordsWithin: mocks.write,
	PAGE_WRITE_TRANSACTION: { maxWait: 10_000, timeout: 10_000 },
	translatePageRecordWriteFailure: (error: unknown) => {
		throw error;
	},
}));

import {
	WorkspaceWorkflowBindingConflictError,
	type WorkspaceWorkflowRunGuard,
} from "../prisma/queries/workflows/workspace-workflow-binding";
import {
	getWorkspaceWorkflowRecord,
	setWorkspaceWorkflowRecord,
} from "../prisma/queries/workflows/workspace-workflow-data";

const stamp = new Date("2026-01-01T12:00:00Z");
const binding: WorkspaceWorkflowRunGuard = {
	workflowId: "workflow",
	userId: "owner",
	organizationId: "example-org",
	projectId: "project",
	workspaceFrameId: "workspace",
	status: "PUBLISHED",
	workflowUpdatedAt: stamp,
	frameUpdatedAt: stamp,
	requirement: { kind: "bound-run", workflowVersion: 3 },
};
const metadata = {
	surface: "workspace",
	workflowBindings: {
		version: 1,
		workflows: [
			{
				workflowId: "workflow",
				authorizedWorkflowVersion: 3,
				authorizedWorkflowUpdatedAt: stamp.toISOString(),
			},
		],
	},
};
const input = {
	binding,
	collection: "state",
	key: "baseline",
	scope: "mine" as const,
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.transactions.length = 0;
	mocks.raw.mockImplementation(async (strings: TemplateStringsArray) => {
		const sql = strings.join("?");
		if (sql.includes("FROM workflow")) {
			return [{ id: "workflow", version: 3, publishedVersion: 3 }];
		}
		if (sql.includes("FROM agent_workspace_file")) {
			return [{ id: "workspace", metadata }];
		}
		return [{ id: "project" }];
	});
	mocks.read.mockResolvedValue(null);
	mocks.write.mockResolvedValue({ records: [] });
});

describe("Workspace workflow record transaction boundary", () => {
	it("checks the grant before mutating through the same transaction", async () => {
		await setWorkspaceWorkflowRecord({
			...input,
			value: {},
			expectedVersion: 2,
		});
		expect(mocks.transactions).toHaveLength(1);
		expect(mocks.raw.mock.calls.map(([sql]) => sql.join("?"))).toEqual([
			expect.stringContaining("FROM workflow"),
			expect.stringContaining("FROM agent_workspace_file"),
			expect.stringContaining("FROM project"),
		]);
		expect(mocks.raw.mock.invocationCallOrder[2]).toBeLessThan(
			mocks.write.mock.invocationCallOrder[0],
		);
		expect(mocks.write).toHaveBeenCalledWith(mocks.transactions[0], {
			frameId: "workspace",
			organizationId: "example-org",
			actorUserId: "owner",
			collection: "state",
			records: [
				{
					key: "baseline",
					scope: "mine",
					value: {},
					expectedVersion: 2,
				},
			],
		});
	});

	it("reads through the same transaction while grant rows remain locked", async () => {
		await getWorkspaceWorkflowRecord(input);
		expect(mocks.transactions).toHaveLength(1);
		expect(mocks.read).toHaveBeenCalledWith(mocks.transactions[0], {
			frameId: "workspace",
			organizationId: "example-org",
			viewerUserId: "owner",
			collection: "state",
			key: "baseline",
			scope: "mine",
		});
	});

	it.each([0, 1, 2])(
		"does not mutate when locked scope read %i fails",
		async (failed) => {
			const validRows = [
				[{ id: "workflow", version: 3, publishedVersion: 3 }],
				[{ id: "workspace", metadata }],
				[{ id: "project" }],
			];
			mocks.raw.mockReset();
			for (let index = 0; index <= failed; index++) {
				mocks.raw.mockResolvedValueOnce(
					index === failed ? [] : validRows[index],
				);
			}
			await expect(
				setWorkspaceWorkflowRecord({
					...input,
					value: {},
					expectedVersion: 0,
				}),
			).rejects.toBeInstanceOf(WorkspaceWorkflowBindingConflictError);
			expect(mocks.write).not.toHaveBeenCalled();
		},
	);

	it("rejects a grant revoked between the activity read and its transaction", async () => {
		mocks.raw.mockResolvedValueOnce([
			{ id: "workflow", version: 3, publishedVersion: 3 },
		]);
		mocks.raw.mockResolvedValueOnce([
			{
				id: "workspace",
				metadata: {
					surface: "workspace",
					workflowBindings: { version: 1, workflows: [] },
				},
			},
		]);
		await expect(
			setWorkspaceWorkflowRecord({
				...input,
				value: {},
				expectedVersion: 0,
			}),
		).rejects.toBeInstanceOf(WorkspaceWorkflowBindingConflictError);
		expect(mocks.write).not.toHaveBeenCalled();
	});
});
