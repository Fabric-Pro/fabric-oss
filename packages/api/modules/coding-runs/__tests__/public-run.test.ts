import { beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ access: vi.fn(), connections: vi.fn() }));
vi.mock("@repo/database", () => ({
	hasProjectAccess: f.access,
	db: { projectRemoteAgentServer: { findMany: f.connections } },
}));

import { publicCodingRuns } from "../lib/public-run";

const run = {
	id: "example-run",
	projectId: "example-project",
	status: "RUNNING",
	providerSessionId: "private-session-id",
	externalUrl: "https://private.example.com",
	workingDirectory: "/example-private-worktree",
	providerMetadata: {
		executionRuntime: "fabric-agent-server",
		executionTarget: {
			connectionId: "example-connection",
			url: "https://private.example.com",
		},
	},
	events: [{ payload: "private runtime details" }],
	pullRequestUrl: "https://github.com/example-org/example-repo/pull/1",
};
beforeEach(() => {
	vi.clearAllMocks();
	f.access.mockResolvedValue(true);
	f.connections.mockResolvedValue([]);
});
it("shares task progress and PRs while withholding another owner's private runtime details", async () => {
	const [result] = await publicCodingRuns([run], "example-teammate");
	expect(result).toMatchObject({
		status: "RUNNING",
		pullRequestUrl: run.pullRequestUrl,
		providerSessionId: null,
		events: [],
		providerMetadata: { privateSession: true },
	});
	expect(JSON.stringify(result)).not.toContain("private.example.com");
	expect(JSON.stringify(result)).not.toContain("private-session-id");
	expect(JSON.stringify(result)).not.toContain("private runtime details");
});
it("preserves the actual runtime projection for the owner or authorized team connection", async () => {
	f.connections.mockResolvedValue([{ id: "example-connection" }]);
	expect((await publicCodingRuns([run], "example-owner"))[0]).toBe(run);
});
it("refuses project outsiders before loading any connection metadata", async () => {
	f.access.mockResolvedValue(false);
	await expect(
		publicCodingRuns([run], "example-outsider"),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	expect(f.connections).not.toHaveBeenCalled();
});
