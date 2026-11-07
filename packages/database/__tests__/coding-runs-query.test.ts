import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst, findMany, findUnique, update } = vi.hoisted(() => ({
	findFirst: vi.fn(),
	findMany: vi.fn(),
	findUnique: vi.fn(),
	update: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		codingRun: {
			findFirst,
			findMany,
			findUnique,
			update,
		},
		codingRunEvent: {
			create: vi.fn(),
		},
	},
}));

import {
	getCodingRun,
	listCodingRunsForStory,
	listCodingRunsForTask,
	updateCodingRunStatus,
} from "../prisma/queries/coding-runs";

describe("coding run query tenant isolation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		findFirst.mockResolvedValue(null);
		findMany.mockResolvedValue([]);
	});

	it("uses userId + organizationId null for personal getCodingRun lookups", async () => {
		await getCodingRun("run_1", "user_1", null);

		expect(findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "run_1",
					userId: "user_1",
					organizationId: null,
				},
			}),
		);
	});

	it("uses organizationId-only filtering for org getCodingRun lookups", async () => {
		await getCodingRun("run_2", "user_1", "org_1");

		expect(findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "run_2",
					organizationId: "org_1",
				},
			}),
		);
	});

	it("uses XOR tenant filter when listing task coding runs in personal context", async () => {
		await listCodingRunsForTask("task_1", "user_1", null);

		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					storyTaskId: "task_1",
					userId: "user_1",
					organizationId: null,
				},
			}),
		);
	});

	it("uses org-scoped filter when listing story coding runs in org context", async () => {
		await listCodingRunsForStory("story_1", "user_1", "org_9");

		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					storyId: "story_1",
					organizationId: "org_9",
				},
			}),
		);
	});
});

describe("immutable coding admission receipt", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		findUnique.mockResolvedValue(null);
	});
	it("preserves the exact admission hash when native session metadata replaces provider configuration", async () => {
		const receipt = { version: 1, requestHash: "a".repeat(64) };
		findUnique.mockResolvedValue({
			providerMetadata: {
				executionRuntime: "fabric-agent-server",
				fabricRequest: receipt,
			},
		});
		await updateCodingRunStatus("example-run", "RUNNING", {
			providerMetadata: {
				nativeSessionId: "example-session",
				fabricRequest: { version: 1, requestHash: "b".repeat(64) },
			},
		});
		expect(update).toHaveBeenCalledWith({
			where: { id: "example-run" },
			data: {
				status: "RUNNING",
				providerMetadata: {
					nativeSessionId: "example-session",
					fabricRequest: receipt,
				},
			},
		});
	});
	it("does not fetch or alter metadata for a status-only update", async () => {
		await updateCodingRunStatus("example-run", "COMPLETED");
		expect(findUnique).not.toHaveBeenCalled();
		expect(update).toHaveBeenCalledWith({
			where: { id: "example-run" },
			data: { status: "COMPLETED" },
		});
	});
	it("preserves legacy replacement behavior when there is no receipt", async () => {
		findUnique.mockResolvedValue({
			providerMetadata: { executionRuntime: "legacy-background-agents" },
		});
		await updateCodingRunStatus("example-run", "RUNNING", {
			providerMetadata: { nativeSessionId: "example-session" },
		});
		expect(update.mock.calls[0][0].data.providerMetadata).toEqual({
			nativeSessionId: "example-session",
		});
	});
});
