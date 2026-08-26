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
}));

import { db, resolvePMConfigForUser } from "@repo/database";
import { getGitLabAccessToken } from "@repo/integrations/gitlab";
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

	// --- Org-level fallback ---------------------------------------------------
	// A project's GitLab REST connection belongs to the project/org, not the
	// individual user who happened to set it up. Code-repo integrations resolve
	// per-project (any teammate can sync); the PM GitLab REST path must behave
	// the same way. In org context, when the calling user has no GitLab
	// integration of their own, fall back to any active org GitLab integration
	// and resolve the token via that integration's owner. Personal projects
	// stay strictly user-scoped (you can't borrow another user's personal OAuth).

	it("org context: falls back to an org-mate's active GitLab integration when the caller has none", async () => {
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "gitlab-official",
		} as never);
		// caller (u2) has no GitLab integration; an org-mate (u1) does.
		vi.mocked(db.workflowIntegration.findFirst)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({ id: "wi-org", userId: "u1" } as never);
		vi.mocked(getGitLabAccessToken).mockResolvedValue("ORG_TOK" as never);

		const source = await resolvePmSource({
			mcpServerId: "srv-gl",
			mcpConfigId: null,
			userId: "u2",
			organizationId: "org-x",
			containerId: "100",
		});

		expect(source).toMatchObject({ kind: "rest-gitlab", token: "ORG_TOK" });
		// Token resolved via the integration's OWNER, not the calling user.
		expect(getGitLabAccessToken).toHaveBeenCalledWith("u1", "org-x");
		// The fallback lookup is org-scoped (no userId) — any active integration.
		const orgCall = vi.mocked(db.workflowIntegration.findFirst).mock
			.calls[1]?.[0];
		expect(orgCall?.where).toMatchObject({
			organizationId: "org-x",
			provider: "GITLAB",
			isActive: true,
		});
		expect(orgCall?.where).not.toHaveProperty("userId");
	});

	it("org context: prefers the caller's own GitLab integration over an org-mate's", async () => {
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "gitlab-official",
		} as never);
		vi.mocked(db.workflowIntegration.findFirst).mockResolvedValueOnce({
			id: "wi-own",
			userId: "u2",
		} as never);
		vi.mocked(getGitLabAccessToken).mockResolvedValue("OWN_TOK" as never);

		const source = await resolvePmSource({
			mcpServerId: "srv-gl",
			mcpConfigId: null,
			userId: "u2",
			organizationId: "org-x",
			containerId: "100",
		});

		expect(source).toMatchObject({ kind: "rest-gitlab", token: "OWN_TOK" });
		// Own integration found on the first lookup — no org fallback needed.
		expect(getGitLabAccessToken).toHaveBeenCalledWith("u2", "org-x");
		expect(
			vi.mocked(db.workflowIntegration.findFirst),
		).toHaveBeenCalledTimes(1);
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
