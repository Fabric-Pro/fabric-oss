/**
 * Unit tests for `resolvePmSource` and `PMSourceNotFound`.
 *
 * The helper is called per-activity (not at workflow level) to rehydrate
 * a discriminated PM source descriptor from primitive workflow args.
 * Tokens never cross the Temporal serialization boundary — they live only
 * inside the activity that resolved them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	resolvePMConfigForUser: vi.fn(),
	isPmServerIdKeySentinel: (id: string) => id.startsWith("key:"),
	readPmServerIdKeySentinel: (id: string) => id.slice("key:".length),
	db: {
		mCPServer: { findUnique: vi.fn() },
		workflowIntegration: { findFirst: vi.fn() },
	},
}));

vi.mock("@repo/integrations/gitlab", () => ({
	getGitLabAccessToken: vi.fn(),
	getFreshGitLabAccessToken: vi.fn(),
}));

import { db, resolvePMConfigForUser } from "@repo/database";
import {
	getFreshGitLabAccessToken,
	getGitLabAccessToken,
} from "@repo/integrations/gitlab";
import {
	connectionRow,
	createWorkflowIntegrationFake,
	type FakeWorkflowIntegrationRow,
} from "../../../__tests__/helpers/workflow-integration-fake";
import {
	PMSourceNotFound,
	resolvePmServerKey,
	resolvePmSource,
} from "../pm-source";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("resolvePmSource", () => {
	it("returns kind=mcp when configId resolves to an enabled config", async () => {
		vi.mocked(resolvePMConfigForUser).mockResolvedValue({
			id: "cfg1",
			enabled: true,
		} as never);

		const source = await resolvePmSource({
			mcpServerId: "srv-x",
			mcpConfigId: "cfg1",
			userId: "u1",
			organizationId: null,
			containerId: "100",
		});

		expect(source).toMatchObject({ kind: "mcp" });
	});

	it("throws PMSourceNotFound(no-config) when configId is set but resolves to a disabled config", async () => {
		vi.mocked(resolvePMConfigForUser).mockResolvedValue({
			id: "cfg1",
			enabled: false,
		} as never);

		await expect(
			resolvePmSource({
				mcpServerId: "srv-x",
				mcpConfigId: "cfg1",
				userId: "u1",
				organizationId: null,
				containerId: "100",
			}),
		).rejects.toBeInstanceOf(PMSourceNotFound);
	});

	it("returns kind=rest-gitlab when configId is null, server is gitlab-official, integration is active", async () => {
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "gitlab-official",
		} as never);
		vi.mocked(db.workflowIntegration.findFirst).mockResolvedValue({
			id: "wi1",
		} as never);
		vi.mocked(getGitLabAccessToken).mockResolvedValue("TOK" as never);

		const source = await resolvePmSource({
			mcpServerId: "srv-gl",
			mcpConfigId: null,
			userId: "u1",
			organizationId: null,
			containerId: "100",
		});

		expect(source).toMatchObject({
			kind: "rest-gitlab",
			token: "TOK",
			projectId: "100",
		});
	});

	it("throws PMSourceNotFound(no-integration) when REST path lacks WorkflowIntegration", async () => {
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "gitlab-official",
		} as never);
		vi.mocked(db.workflowIntegration.findFirst).mockResolvedValue(null);

		await expect(
			resolvePmSource({
				mcpServerId: "srv-gl",
				mcpConfigId: null,
				userId: "u1",
				organizationId: null,
				containerId: "100",
			}),
		).rejects.toBeInstanceOf(PMSourceNotFound);
	});

	it("throws PMSourceNotFound(token-failed) when getGitLabAccessToken returns null", async () => {
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "gitlab-official",
		} as never);
		vi.mocked(db.workflowIntegration.findFirst).mockResolvedValue({
			id: "wi1",
		} as never);
		vi.mocked(getGitLabAccessToken).mockResolvedValue(null);

		await expect(
			resolvePmSource({
				mcpServerId: "srv-gl",
				mcpConfigId: null,
				userId: "u1",
				organizationId: null,
				containerId: "100",
			}),
		).rejects.toBeInstanceOf(PMSourceNotFound);
	});

	it("throws PMSourceNotFound(token-failed) when getGitLabAccessToken throws", async () => {
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "gitlab-official",
		} as never);
		vi.mocked(db.workflowIntegration.findFirst).mockResolvedValue({
			id: "wi1",
		} as never);
		vi.mocked(getGitLabAccessToken).mockRejectedValue(
			new Error("refresh failed"),
		);

		await expect(
			resolvePmSource({
				mcpServerId: "srv-gl",
				mcpConfigId: null,
				userId: "u1",
				organizationId: null,
				containerId: "100",
			}),
		).rejects.toBeInstanceOf(PMSourceNotFound);
	});

	it("throws PMSourceNotFound(no-config) when configId is set but resolvePMConfigForUser returns null", async () => {
		vi.mocked(resolvePMConfigForUser).mockResolvedValue(null);

		await expect(
			resolvePmSource({
				mcpServerId: "srv-x",
				mcpConfigId: "cfg-missing",
				userId: "u1",
				organizationId: null,
				containerId: "100",
			}),
		).rejects.toBeInstanceOf(PMSourceNotFound);
	});

	it("throws PMSourceNotFound(no-config) when configId is null and server is not gitlab-official", async () => {
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "fizzy",
		} as never);

		await expect(
			resolvePmSource({
				mcpServerId: "srv-fz",
				mcpConfigId: null,
				userId: "u1",
				organizationId: null,
				containerId: "100",
			}),
		).rejects.toBeInstanceOf(PMSourceNotFound);
	});

	it("uses XOR tenant filter (org context) for the WorkflowIntegration lookup", async () => {
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "gitlab-official",
		} as never);
		vi.mocked(db.workflowIntegration.findFirst).mockResolvedValue({
			id: "wi1",
		} as never);
		vi.mocked(getGitLabAccessToken).mockResolvedValue("T" as never);

		await resolvePmSource({
			mcpServerId: "srv-gl",
			mcpConfigId: null,
			userId: "u1",
			organizationId: "org-x",
			containerId: "100",
		});

		const call = vi.mocked(db.workflowIntegration.findFirst).mock
			.calls[0]?.[0];
		expect(call?.where).toMatchObject({
			provider: "GITLAB",
			isActive: true,
			userId: "u1",
			organizationId: "org-x",
		});
	});

	it("returns kind=rest-gitlab for the key:gitlab-official sentinel without touching the catalog", async () => {
		vi.mocked(db.workflowIntegration.findFirst).mockResolvedValue({
			id: "wi1",
		} as never);
		vi.mocked(getGitLabAccessToken).mockResolvedValue("TOK" as never);

		const source = await resolvePmSource({
			mcpServerId: "key:gitlab-official",
			mcpConfigId: null,
			userId: "u1",
			organizationId: null,
			containerId: "100",
		});

		expect(vi.mocked(db.mCPServer.findUnique)).not.toHaveBeenCalled();
		expect(source).toMatchObject({
			kind: "rest-gitlab",
			token: "TOK",
			projectId: "100",
		});
	});

	it("throws PMSourceNotFound(no-integration) for the sentinel when no active WorkflowIntegration", async () => {
		vi.mocked(db.workflowIntegration.findFirst).mockResolvedValue(null);

		await expect(
			resolvePmSource({
				mcpServerId: "key:gitlab-official",
				mcpConfigId: null,
				userId: "u1",
				organizationId: null,
				containerId: "100",
			}),
		).rejects.toBeInstanceOf(PMSourceNotFound);
		expect(vi.mocked(db.mCPServer.findUnique)).not.toHaveBeenCalled();
	});

	// --- Connection owner ----------------------------------------------------
	// A GitLab WorkflowIntegration is a member's personal OAuth connection. In
	// org context the REST path must act through the CALLER's own connection
	// and never fall back to a teammate's, so a member who never connected
	// (or disconnected) cannot read or write tickets through someone else's
	// account. Rows are seeded in an in-memory store (teammate first) so a
	// lookup without `userId` in the organization arm would pick the teammate.

	const teammateGitLab = connectionRow({
		id: "wi-teammate",
		userId: "user-1",
		provider: "GITLAB",
	});
	const callerGitLab = connectionRow({
		id: "wi-caller",
		userId: "user-2",
		provider: "GITLAB",
	});

	function seed(rows: FakeWorkflowIntegrationRow[]) {
		const fake = createWorkflowIntegrationFake(rows);
		vi.mocked(db.workflowIntegration.findFirst).mockImplementation(
			fake.findFirst as never,
		);
	}

	it("org context: never borrows a teammate's GitLab connection when the caller has none", async () => {
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "gitlab-official",
		} as never);
		seed([teammateGitLab]);
		vi.mocked(getGitLabAccessToken).mockResolvedValue("TEAMMATE_TOK");

		await expect(
			resolvePmSource({
				mcpServerId: "srv-gl",
				mcpConfigId: null,
				userId: "user-2",
				organizationId: "org-example",
				containerId: "100",
			}),
		).rejects.toMatchObject({ reason: "no-integration" });
		expect(getGitLabAccessToken).not.toHaveBeenCalled();
	});

	it("org context: uses the caller's own GitLab connection, not a teammate's", async () => {
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "gitlab-official",
		} as never);
		seed([teammateGitLab, callerGitLab]);
		vi.mocked(getGitLabAccessToken).mockImplementation(
			async (userId: string) => `${userId}-token`,
		);

		const source = await resolvePmSource({
			mcpServerId: "srv-gl",
			mcpConfigId: null,
			userId: "user-2",
			organizationId: "org-example",
			containerId: "100",
		});

		expect(source).toMatchObject({
			kind: "rest-gitlab",
			token: "user-2-token",
		});
		expect(getGitLabAccessToken).toHaveBeenCalledWith(
			"user-2",
			"org-example",
		);
	});

	it("the hourly poll (requireFreshToken) acts as the project owner, never a teammate", async () => {
		seed([teammateGitLab]);

		await expect(
			resolvePmSource({
				mcpServerId: "key:gitlab-official",
				mcpConfigId: null,
				userId: "user-2",
				organizationId: "org-example",
				containerId: "100",
				requireFreshToken: true,
			}),
		).rejects.toMatchObject({ reason: "no-integration" });
		expect(getFreshGitLabAccessToken).not.toHaveBeenCalled();
	});

	it("personal context: never borrows another user's integration (stays user-scoped)", async () => {
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "gitlab-official",
		} as never);
		vi.mocked(db.workflowIntegration.findFirst).mockResolvedValue(null);

		await expect(
			resolvePmSource({
				mcpServerId: "srv-gl",
				mcpConfigId: null,
				userId: "u2",
				organizationId: null,
				containerId: "100",
			}),
		).rejects.toBeInstanceOf(PMSourceNotFound);
		// Only the single user-scoped lookup — no org fallback in personal ctx.
		expect(
			vi.mocked(db.workflowIntegration.findFirst),
		).toHaveBeenCalledTimes(1);
	});

	describe("requireFreshToken (the hourly poll)", () => {
		const restArgs = {
			mcpServerId: "key:gitlab-official",
			mcpConfigId: null,
			userId: "u1",
			organizationId: "org-x",
			containerId: "100",
			requireFreshToken: true,
		};
		beforeEach(() => {
			vi.mocked(db.workflowIntegration.findFirst).mockResolvedValue({
				id: "wi1",
				userId: "u1",
			} as never);
		});

		it("throws token-failed WITH the fixed reason when the token is dead and the refresh failed", async () => {
			vi.mocked(getFreshGitLabAccessToken).mockResolvedValue({
				ok: false,
				reason: "GitLab rejected the token refresh (HTTP 401 invalid_client)",
			});
			const err = await resolvePmSource(restArgs).catch(
				(e: unknown) => e,
			);
			expect(err).toBeInstanceOf(PMSourceNotFound);
			expect(err).toMatchObject({
				reason: "token-failed",
				detail: "GitLab rejected the token refresh (HTTP 401 invalid_client)",
			});
			expect(getGitLabAccessToken).not.toHaveBeenCalled();
		});

		it("returns the source with a fresh token", async () => {
			vi.mocked(getFreshGitLabAccessToken).mockResolvedValue({
				ok: true,
				token: "FRESH",
			});
			expect(await resolvePmSource(restArgs)).toMatchObject({
				kind: "rest-gitlab",
				token: "FRESH",
			});
		});

		it("throws token-failed without detail when the integration row vanished", async () => {
			vi.mocked(getFreshGitLabAccessToken).mockResolvedValue(null);
			await expect(resolvePmSource(restArgs)).rejects.toMatchObject({
				reason: "token-failed",
				detail: undefined,
			});
			// Proves the STRICT branch actually ran (not, say, some other path
			// that happens to reject with the same shape).
			expect(getFreshGitLabAccessToken).toHaveBeenCalled();
			expect(getGitLabAccessToken).not.toHaveBeenCalled();
		});

		it("throws token-failed without detail when getFreshGitLabAccessToken itself rejects", async () => {
			vi.mocked(getFreshGitLabAccessToken).mockRejectedValue(
				new Error("db down"),
			);
			await expect(resolvePmSource(restArgs)).rejects.toMatchObject({
				reason: "token-failed",
				detail: undefined,
			});
			expect(getFreshGitLabAccessToken).toHaveBeenCalled();
			expect(getGitLabAccessToken).not.toHaveBeenCalled();
		});

		it("positive control: without requireFreshToken the lenient getter is used, as today", async () => {
			vi.mocked(getGitLabAccessToken).mockResolvedValue(
				"LENIENT" as never,
			);
			expect(
				await resolvePmSource({
					...restArgs,
					requireFreshToken: undefined,
				}),
			).toMatchObject({ token: "LENIENT" });
			expect(getFreshGitLabAccessToken).not.toHaveBeenCalled();
		});
	});
});

describe("resolvePmServerKey", () => {
	it("reads the sentinel form without a DB lookup", async () => {
		// isPmServerIdKeySentinel/readPmServerIdKeySentinel are real (pure) —
		// a "key:gitlab-official" sentinel resolves directly.
		const key = await resolvePmServerKey("key:gitlab-official");
		expect(key).toBe("gitlab-official");
	});

	it("looks up the MCPServer.key by id for a UUID", async () => {
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "fizzy",
		} as never);
		const key = await resolvePmServerKey(
			"11111111-1111-1111-1111-111111111111",
		);
		expect(key).toBe("fizzy");
	});

	it("returns null when the server row is missing", async () => {
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue(null as never);
		const key = await resolvePmServerKey("missing-id");
		expect(key).toBeNull();
	});
});
