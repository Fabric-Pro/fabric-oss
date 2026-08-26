/**
 * Tests for the GitLab REST branch in `previewPmSyncConflict`.
 *
 * When `mcpConfigId` is null the activity resolves a REST source and fetches
 * the live PM-side content via `callPmToolWithFallback({tool: "fetchItem"})`
 * instead of going through the MCP capabilities + `fetchPmTicket` pipeline.
 * Without this, the resolve-conflict modal opened with empty TITLE /
 * DESCRIPTION on the PM column for GitLab REST projects (the row was already
 * stamped CONFLICT — only the live preview was broken).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@temporalio/activity", async () => {
	const actual = await vi.importActual<object>("@temporalio/activity");
	return {
		...actual,
		Context: { current: () => ({ heartbeat: vi.fn() }) },
	};
});

const { resolvePmSource, PMSourceNotFound } = vi.hoisted(() => {
	class PMSourceNotFound extends Error {
		constructor(public reason: string) {
			super(`PM source not resolvable: ${reason}`);
			this.name = "PMSourceNotFound";
		}
	}
	return { resolvePmSource: vi.fn(), PMSourceNotFound };
});

const { callPmToolWithFallback } = vi.hoisted(() => ({
	callPmToolWithFallback: vi.fn(),
}));

const { getEpicById, getFeatureById, getStoryById } = vi.hoisted(() => ({
	getEpicById: vi.fn(),
	getFeatureById: vi.fn(),
	getStoryById: vi.fn(),
}));

const { discoverPMToolCapabilitiesResult, fetchPmTicket } = vi.hoisted(() => ({
	discoverPMToolCapabilitiesResult: vi.fn(),
	fetchPmTicket: vi.fn(),
}));

const { resolvePMConfigForUser } = vi.hoisted(() => ({
	resolvePMConfigForUser: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}));
vi.mock("@repo/database", () => ({
	getEpicById,
	getFeatureById,
	getStoryById,
	resolvePMConfigForUser,
}));
vi.mock("../../pm-source", () => ({ resolvePmSource, PMSourceNotFound }));
vi.mock("../../pm-tool-fallback", () => ({ callPmToolWithFallback }));
vi.mock("../fetch-pm-ticket", () => ({ fetchPmTicket }));
vi.mock("../story-sync", () => ({ discoverPMToolCapabilitiesResult }));

import {
	appendAttachmentBlock,
	renderAttachmentBlock,
} from "../gitlab-attachment-block";
import { computePmHash } from "../pm-sync-hash";
import { previewPmSyncConflict } from "../preview-pm-sync-conflict";

const REST_SOURCE = {
	kind: "rest-gitlab" as const,
	token: "TOK",
	baseUrl: "https://gitlab.com/api/v4",
	projectId: "100",
};

const baseRestInput = (overrides: Record<string, unknown> = {}) => ({
	itemId: "story-1",
	itemType: "story" as const,
	projectId: "proj-1",
	mcpConfigId: null,
	mcpServerId: "key:gitlab-official",
	containerId: "group/project",
	userId: "user-1",
	organizationId: "org-1",
	...overrides,
});

beforeEach(() => {
	vi.clearAllMocks();
	resolvePmSource.mockResolvedValue(REST_SOURCE);
	// MCP path default: the caller owns an enabled config for the PM server.
	resolvePMConfigForUser.mockResolvedValue({ id: "mcp-1", enabled: true });
});

describe("previewPmSyncConflict — GitLab REST branch", () => {
	it("returns hasConflict: true with pmCurrent when live hash differs from baseline", async () => {
		getStoryById.mockResolvedValue({
			externalId: "42",
			lastSyncedPmHash: "stale-baseline-hash",
		});
		callPmToolWithFallback.mockResolvedValue({
			title: "Edited in GitLab",
			description: "Someone touched this on the PM side",
			externalUrl: "https://gitlab.com/group/project/-/issues/42",
			labels: [],
		});

		const result = await previewPmSyncConflict(baseRestInput());

		// Resolver invoked with REST args; MCP capabilities + fetchPmTicket
		// are bypassed entirely.
		expect(resolvePmSource).toHaveBeenCalledWith(
			expect.objectContaining({
				mcpConfigId: null,
				mcpServerId: "key:gitlab-official",
			}),
		);
		expect(discoverPMToolCapabilitiesResult).not.toHaveBeenCalled();
		expect(fetchPmTicket).not.toHaveBeenCalled();

		expect(callPmToolWithFallback).toHaveBeenCalledWith(
			expect.objectContaining({
				source: REST_SOURCE,
				call: { tool: "fetchItem", externalId: "42" },
			}),
		);

		expect(result.hasConflict).toBe(true);
		expect(result.pmCurrent).toEqual({
			title: "Edited in GitLab",
			description: "Someone touched this on the PM side",
			lastChangedBy: null,
			lastChangedAt: null,
		});
		expect(result.pmUrl).toBe(
			"https://gitlab.com/group/project/-/issues/42",
		);
	});

	// R14 (Fizzy #1745, review round 1): the Fabric-owned attachment block
	// must be stripped before hashing AND from `pmCurrent.description`.
	// Left unstripped: (1) the baseline — stamped block-free by
	// gitlab-rest-story-sync.ts's push/pull — never matches a
	// block-containing live hash, so every GitLab story with attachments
	// shows a phantom "PM changed" conflict; and (2) `pmCurrent.description`
	// flows into `proposeAiMerge`, and accepting that merge writes it back
	// to the Fabric story via `resolveConflict` LOCAL — so the block would
	// reach the editor and the next push would append a second copy.
	it("R14: a live description with only the attachment block appended does NOT register as a conflict, and pmCurrent.description is block-free", async () => {
		const liveTitle = "My Feature";
		const liveBody = "Body";
		// The baseline was stamped block-free (mirrors gitlab-rest-story-sync.ts).
		const blockFreeBaseline = computePmHash(liveTitle, liveBody);
		getStoryById.mockResolvedValue({
			externalId: "42",
			lastSyncedPmHash: blockFreeBaseline,
		});

		const block = renderAttachmentBlock({
			links: [
				{
					filename: "spec.pdf",
					path: `/uploads/${"c".repeat(32)}/spec.pdf`,
				},
			],
			excluded: [],
		});
		const liveDescriptionWithBlock = appendAttachmentBlock(liveBody, block);
		callPmToolWithFallback.mockResolvedValue({
			title: liveTitle,
			description: liveDescriptionWithBlock,
			externalUrl: "https://gitlab.com/group/project/-/issues/42",
			labels: [],
		});

		const result = await previewPmSyncConflict(baseRestInput());

		// No phantom conflict purely from the block's presence.
		expect(result.hasConflict).toBe(false);
		// And the description handed to the caller (→ proposeAiMerge →
		// possible LOCAL resolveConflict write-back) never carries the block.
		expect(result.pmCurrent?.description).not.toContain(
			"fabric:attachments",
		);
		expect(result.pmCurrent?.description).not.toContain("spec.pdf");
		expect(result.pmCurrent?.description).toContain("Body");
	});

	it("returns hasConflict: false when live hash matches baseline (still surfaces pmCurrent for the dialog)", async () => {
		const liveTitle = "My Feature";
		const liveDescription = "Body";
		const matchingBaseline = computePmHash(liveTitle, liveDescription);
		getStoryById.mockResolvedValue({
			externalId: "42",
			lastSyncedPmHash: matchingBaseline,
		});
		callPmToolWithFallback.mockResolvedValue({
			title: liveTitle,
			description: liveDescription,
			externalUrl: "https://gitlab.com/group/project/-/issues/42",
			labels: [],
		});

		const result = await previewPmSyncConflict(baseRestInput());

		expect(result.hasConflict).toBe(false);
		expect(result.pmCurrent?.title).toBe("My Feature");
		expect(result.pmCurrent?.description).toBe("Body");
	});

	it("returns hasConflict: false when baseline is null (first-ever sync, nothing to compare)", async () => {
		getStoryById.mockResolvedValue({
			externalId: "42",
			lastSyncedPmHash: null,
		});
		callPmToolWithFallback.mockResolvedValue({
			title: "Anything",
			description: "Anything",
			externalUrl: "https://gitlab.com/group/project/-/issues/42",
			labels: [],
		});

		const result = await previewPmSyncConflict(baseRestInput());

		expect(result.hasConflict).toBe(false);
	});

	it("handles null description from the REST adapter without crashing", async () => {
		getStoryById.mockResolvedValue({
			externalId: "42",
			lastSyncedPmHash: "any-baseline",
		});
		callPmToolWithFallback.mockResolvedValue({
			title: "Issue title only",
			description: null,
			externalUrl: "https://gitlab.com/group/project/-/issues/42",
			labels: [],
		});

		const result = await previewPmSyncConflict(baseRestInput());

		expect(result.pmCurrent?.description).toBe("");
	});

	it("returns hasConflict: false when the REST fetch throws (doesn't blank out the batched preview)", async () => {
		getStoryById.mockResolvedValue({
			externalId: "42",
			lastSyncedPmHash: "any-baseline",
		});
		callPmToolWithFallback.mockRejectedValue(
			new Error("500 Internal Server Error"),
		);

		const result = await previewPmSyncConflict(baseRestInput());

		expect(result.hasConflict).toBe(false);
		expect(result.pmCurrent).toBeUndefined();
	});

	it("returns hasConflict: false when source resolver throws PMSourceNotFound", async () => {
		getStoryById.mockResolvedValue({
			externalId: "42",
			lastSyncedPmHash: "any-baseline",
		});
		resolvePmSource.mockRejectedValue(
			new PMSourceNotFound("no-integration"),
		);

		const result = await previewPmSyncConflict(baseRestInput());

		expect(result.hasConflict).toBe(false);
		expect(callPmToolWithFallback).not.toHaveBeenCalled();
	});

	it("short-circuits to hasConflict: false for epic / feature itemTypes (no REST hierarchy routine)", async () => {
		getEpicById.mockResolvedValue({
			externalId: "42",
			lastSyncedPmHash: "any-baseline",
		});

		const epicResult = await previewPmSyncConflict(
			baseRestInput({ itemType: "epic" }),
		);
		expect(epicResult.hasConflict).toBe(false);
		expect(resolvePmSource).not.toHaveBeenCalled();
		expect(callPmToolWithFallback).not.toHaveBeenCalled();

		getFeatureById.mockResolvedValue({
			externalId: "42",
			lastSyncedPmHash: "any-baseline",
		});
		const featureResult = await previewPmSyncConflict(
			baseRestInput({ itemType: "feature" }),
		);
		expect(featureResult.hasConflict).toBe(false);
		expect(resolvePmSource).not.toHaveBeenCalled();
	});

	it("throws PmCapabilitiesError when REST path lacks mcpServerId", async () => {
		getStoryById.mockResolvedValue({
			externalId: "42",
			lastSyncedPmHash: "any-baseline",
		});

		await expect(
			previewPmSyncConflict(baseRestInput({ mcpServerId: undefined })),
		).rejects.toMatchObject({ type: "PmCapabilitiesError" });
	});

	it("returns hasConflict: false when the item has no externalId (never synced)", async () => {
		getStoryById.mockResolvedValue({
			externalId: null,
			lastSyncedPmHash: null,
		});

		const result = await previewPmSyncConflict(baseRestInput());

		expect(result.hasConflict).toBe(false);
		expect(resolvePmSource).not.toHaveBeenCalled();
	});

	it("MCP path resolves the caller's OWN config and routes through capabilities + fetchPmTicket", async () => {
		getStoryById.mockResolvedValue({
			externalId: "42",
			lastSyncedPmHash: "baseline-hash",
		});
		// The project pins "creator-config"; the caller owns "my-config" for the
		// same server — per-user resolution returns the caller's config.
		resolvePMConfigForUser.mockResolvedValue({
			id: "my-config",
			enabled: true,
		});
		discoverPMToolCapabilitiesResult.mockResolvedValue({
			ok: true,
			capabilities: {
				taskGet: { toolName: "wit_get_work_item", idParam: "id" },
				detectedType: "azure-devops",
			},
		});
		fetchPmTicket.mockResolvedValue({
			title: "ADO Title",
			description: "ADO Desc",
			lastChangedBy: "Alice",
			lastChangedAt: "2026-05-28T12:00:00Z",
			url: "https://dev.azure.com/org/proj/_workitems/edit/42",
		});

		const result = await previewPmSyncConflict({
			itemId: "story-1",
			itemType: "story",
			projectId: "proj-1",
			mcpConfigId: "creator-config",
			containerId: "container-1",
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(resolvePMConfigForUser).toHaveBeenCalledWith(
			expect.objectContaining({
				configId: "creator-config",
				userId: "user-1",
				organizationId: "org-1",
			}),
		);
		// The RESOLVED config id (not the creator's pinned id) is threaded into
		// both capability discovery and the ticket fetch.
		expect(discoverPMToolCapabilitiesResult).toHaveBeenCalledWith(
			expect.objectContaining({ mcpConfigId: "my-config" }),
		);
		expect(fetchPmTicket).toHaveBeenCalledWith(
			expect.objectContaining({ mcpConfigId: "my-config" }),
		);
		expect(resolvePmSource).not.toHaveBeenCalled();
		expect(callPmToolWithFallback).not.toHaveBeenCalled();
		expect(result.pmCurrent?.lastChangedBy).toBe("Alice");
	});

	it("MCP path: non-creator WITHOUT their own config → pmError MISSING (no false 'no conflict')", async () => {
		getStoryById.mockResolvedValue({
			externalId: "42",
			lastSyncedPmHash: "baseline-hash",
		});
		// Caller hasn't connected their own PM account for this server.
		resolvePMConfigForUser.mockResolvedValue(null);

		const result = await previewPmSyncConflict({
			itemId: "story-1",
			itemType: "story",
			projectId: "proj-1",
			mcpConfigId: "creator-config",
			containerId: "container-1",
			userId: "user-2",
			organizationId: "org-1",
		});

		expect(result.hasConflict).toBe(false);
		expect(result.pmError).toEqual({ kind: "MISSING" });
		// Never even attempts discovery / fetch without a config.
		expect(discoverPMToolCapabilitiesResult).not.toHaveBeenCalled();
		expect(fetchPmTicket).not.toHaveBeenCalled();
	});

	it("MCP path: disabled config → pmError DISABLED", async () => {
		getStoryById.mockResolvedValue({
			externalId: "42",
			lastSyncedPmHash: "baseline-hash",
		});
		resolvePMConfigForUser.mockResolvedValue({
			id: "my-config",
			enabled: false,
		});

		const result = await previewPmSyncConflict({
			itemId: "story-1",
			itemType: "story",
			projectId: "proj-1",
			mcpConfigId: "creator-config",
			containerId: "container-1",
			userId: "user-2",
			organizationId: "org-1",
		});

		expect(result.pmError).toEqual({ kind: "DISABLED" });
	});

	it("MCP path: expired/auth-failed connection → pmError EXPIRED with code", async () => {
		getStoryById.mockResolvedValue({
			externalId: "42",
			lastSyncedPmHash: "baseline-hash",
		});
		discoverPMToolCapabilitiesResult.mockResolvedValue({
			ok: false,
			error: { code: "AUTH_FAILED", message: "401 Unauthorized" },
		});

		const result = await previewPmSyncConflict({
			itemId: "story-1",
			itemType: "story",
			projectId: "proj-1",
			mcpConfigId: "creator-config",
			containerId: "container-1",
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(result.hasConflict).toBe(false);
		expect(result.pmError).toEqual({
			kind: "EXPIRED",
			code: "AUTH_FAILED",
		});
		expect(fetchPmTicket).not.toHaveBeenCalled();
	});

	it("MCP path: fetch throws a 403 after valid capabilities → pmError NO_ACCESS", async () => {
		getStoryById.mockResolvedValue({
			externalId: "42",
			lastSyncedPmHash: "baseline-hash",
		});
		discoverPMToolCapabilitiesResult.mockResolvedValue({
			ok: true,
			capabilities: {
				taskGet: { toolName: "wit_get_work_item", idParam: "id" },
				detectedType: "azure-devops",
			},
		});
		fetchPmTicket.mockRejectedValue(
			new Error("403 Forbidden — TF401027: no access to this project"),
		);

		const result = await previewPmSyncConflict({
			itemId: "story-1",
			itemType: "story",
			projectId: "proj-1",
			mcpConfigId: "creator-config",
			containerId: "container-1",
			userId: "user-2",
			organizationId: "org-1",
		});

		expect(result.hasConflict).toBe(false);
		expect(result.pmError).toEqual({ kind: "NO_ACCESS" });
	});
});
