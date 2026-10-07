import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ getDirectRepositoryState: vi.fn() }));

vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: m.getDirectRepositoryState,
}));

import { resolveGatewayDirectInstructionRead } from "../instruction-direct-repository";

const READY = {
	availability: "READY" as const,
	readState: "DIRECT" as const,
	generation: 7,
	currentCommitSha: "a".repeat(40),
	ref: "main",
	rootPath: "",
	provider: "GITHUB" as const,
	repository: {
		provider: "GITHUB" as const,
		host: "github.com",
		path: "example-org/instructions",
		cloneUrl: "https://github.com/example-org/instructions.git",
	},
};

beforeEach(() => {
	m.getDirectRepositoryState.mockReset();
});

describe("resolveGatewayDirectInstructionRead", () => {
	it("uses a pinned direct repository only when the gateway read gate holds before and after provider work", async () => {
		m.getDirectRepositoryState.mockResolvedValue(READY);
		const ensureInstructionRead = vi.fn().mockResolvedValue(true);

		await expect(
			resolveGatewayDirectInstructionRead({
				projectId: "project-1",
				userId: "user-1",
				ensureInstructionRead,
			}),
		).resolves.toEqual({ kind: "repository", state: READY });
		expect(ensureInstructionRead).toHaveBeenCalledTimes(2);
		expect(m.getDirectRepositoryState).toHaveBeenCalledExactlyOnceWith({
			projectId: "project-1",
			userId: "user-1",
		});
	});

	it("does not call the provider state service when the initial project read gate refuses", async () => {
		await expect(
			resolveGatewayDirectInstructionRead({
				projectId: "project-1",
				userId: "user-1",
				ensureInstructionRead: vi.fn().mockResolvedValue(false),
			}),
		).resolves.toEqual({ kind: "denied" });
		expect(m.getDirectRepositoryState).not.toHaveBeenCalled();
	});

	it("does not release a resolved repository when the repeated gateway gate was revoked", async () => {
		m.getDirectRepositoryState.mockResolvedValue(READY);
		const ensureInstructionRead = vi
			.fn()
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);

		await expect(
			resolveGatewayDirectInstructionRead({
				projectId: "project-1",
				userId: "user-1",
				ensureInstructionRead,
			}),
		).resolves.toEqual({ kind: "denied" });
	});

	it("keeps upload and migration states on their compatible snapshot path", async () => {
		m.getDirectRepositoryState.mockResolvedValueOnce({
			availability: "UPLOAD",
			readState: "DIRECT",
		});
		await expect(
			resolveGatewayDirectInstructionRead({
				projectId: "project-1",
				userId: "user-1",
				ensureInstructionRead: vi.fn().mockResolvedValue(true),
			}),
		).resolves.toEqual({ kind: "legacy" });

		m.getDirectRepositoryState.mockResolvedValueOnce({
			availability: "MIGRATING",
			readState: "DIRECT",
		});
		await expect(
			resolveGatewayDirectInstructionRead({
				projectId: "project-1",
				userId: "user-1",
				ensureInstructionRead: vi.fn().mockResolvedValue(true),
			}),
		).resolves.toEqual({ kind: "legacy" });
	});

	it("does not fall back to snapshots when a repository is unavailable", async () => {
		m.getDirectRepositoryState.mockResolvedValue({
			availability: "CREDENTIALS_EXPIRED",
			readState: "DIRECT",
		});

		await expect(
			resolveGatewayDirectInstructionRead({
				projectId: "project-1",
				userId: "user-1",
				ensureInstructionRead: vi.fn().mockResolvedValue(true),
			}),
		).resolves.toEqual({
			kind: "unavailable",
			state: { availability: "CREDENTIALS_EXPIRED", readState: "DIRECT" },
		});
	});
});
