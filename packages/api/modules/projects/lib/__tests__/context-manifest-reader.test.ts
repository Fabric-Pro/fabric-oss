import { createHash } from "node:crypto";
import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildContextDiscoveryManifest } from "../context-download-manifest";
import { createContextManifestReader } from "../context-manifest-reader";

const actor = {
	userId: "example-user",
	organizationId: "example-org",
	projectId: "example-project",
};
const hash = createHash("sha256").update("Exact 😀\n").digest("hex");
const row = {
	sourceId: "example-source",
	title: "Example context",
	type: "TEXT",
	extractionStatus: "COMPLETED",
	indexingExcluded: false,
	updatedAt: new Date("2026-01-01"),
	hasLifecycle: true,
	bodyKind: "inline" as "inline" | "composite",
	hasText: true,
	privateConversation: false,
	byteLength: 11,
	revision: hash,
};
const deps = {
	resolveAccess: vi.fn(),
	hasAccess: vi.fn(),
	isDeleted: vi.fn(),
	list: vi.fn(),
};
const read = createContextManifestReader(deps);
beforeEach(() => {
	vi.resetAllMocks();
	deps.resolveAccess.mockResolvedValue({
		organizationId: actor.organizationId,
		permissions: [Permissions.CONTEXT_READ],
		source: "project-member",
	});
	deps.hasAccess.mockResolvedValue(true);
	deps.isDeleted.mockResolvedValue(false);
	deps.list.mockResolvedValue({
		rows: [row],
		total: 3,
		excludedCodeContexts: 2,
		hasMore: true,
	});
});
describe("authorized inspectable Context manifest", () => {
	it("returns metadata, current source pins/read refs/citations/omissions without exporting bodies or inferring Workspace attachments", async () => {
		deps.list.mockResolvedValue({
			rows: [
				{
					...row,
					content: "private-example-body",
					s3Path: "private-example-object",
					metadata: { token: "private-example-token" },
				},
			],
			total: 3,
			excludedCodeContexts: 2,
			hasMore: true,
		});
		const manifest = await read(actor, { limit: 1 });
		expect(manifest).toMatchObject({
			version: 1,
			organizationId: actor.organizationId,
			projectId: actor.projectId,
			sources: [
				{
					sourceId: row.sourceId,
					revision: hash,
					readiness: "ready",
					readUrl:
						"/api/v1/projects/example-project/context-quality/sources/example-source",
					readTool: {
						name: "fabric_inspect_context_quality_source",
						args: {
							projectId: actor.projectId,
							sourceId: row.sourceId,
						},
					},
					citation: {
						sourceId: row.sourceId,
						projectId: actor.projectId,
						revision: hash,
					},
				},
			],
			omissions: {
				sourceBodies: true,
				workspaceDocuments: "separate_scope",
				excludedCodeContexts: 2,
			},
			readPolicy: "compare_returned_revision",
			pagination: {
				nextOffset: 1,
				snapshotConsistent: false,
				mode: "live_offset",
			},
		});
		expect(manifest).not.toHaveProperty("userId");
		expect(JSON.stringify(manifest)).not.toContain("private-example");
		expect(deps.resolveAccess).toHaveBeenCalledTimes(2);
		expect(deps.hasAccess).toHaveBeenCalledWith(
			actor.projectId,
			actor.userId,
			actor.organizationId,
		);
	});
	it.each([
		null,
		{
			organizationId: "other-org",
			permissions: [Permissions.CONTEXT_READ],
		},
		{
			organizationId: actor.organizationId,
			organizationDeleted: true,
			permissions: [Permissions.CONTEXT_READ],
		},
	])(
		"refuses missing/wrong/deleted host before metadata (%j)",
		async (access) => {
			deps.resolveAccess.mockResolvedValue(access);
			await expect(read(actor, {})).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			expect(deps.list).not.toHaveBeenCalled();
		},
	);
	it("does not replace object access with an organization permission fallback", async () => {
		deps.hasAccess.mockResolvedValue(false);
		await expect(read(actor, {})).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(deps.list).not.toHaveBeenCalled();
	});
	it("requires the current CONTEXT_READ role, including for wildcard-key callers", async () => {
		deps.resolveAccess.mockResolvedValue({
			organizationId: actor.organizationId,
			permissions: [],
			source: "project-member",
		});
		await expect(read(actor, {})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(deps.list).not.toHaveBeenCalled();
	});
	it("withholds metadata when access is revoked during its read", async () => {
		deps.hasAccess.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		await expect(read(actor, {})).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(deps.list).toHaveBeenCalledTimes(1);
	});
	it("allows an invited project member without requiring an organization membership branch", async () => {
		await expect(
			read(actor, { includeCodeContexts: true, type: "CODE_FILE" }),
		).resolves.toMatchObject({ organizationId: actor.organizationId });
		expect(deps.list).toHaveBeenCalledWith({
			...actor,
			limit: 20,
			offset: 0,
			includeCodeContexts: true,
			type: "CODE_FILE",
		});
	});
	it.each([
		{ limit: 0 },
		{ limit: 51 },
		{ offset: -1 },
		{ offset: 1.1 },
		{ includeCodeContexts: "true" },
		{ type: "UNKNOWN" },
		{ workspaceIds: ["example-workspace"] },
		{ organizationId: "other-org" },
	])(
		"rejects unbounded or invented filters %j before reading",
		async (page) => {
			await expect(read(actor, page)).rejects.toMatchObject({
				code: "INVALID_INPUT",
			});
			expect(deps.list).not.toHaveBeenCalled();
		},
	);
});
describe("manifest readiness and revision provenance", () => {
	const build = (override: Partial<typeof row> = {}) =>
		buildContextDiscoveryManifest({
			...actor,
			rows: [{ ...row, ...override }],
			offset: 0,
			limit: 20,
			total: 1,
			hasMore: false,
			excludedCodeContexts: 0,
		}).sources[0];
	it.each([
		["PENDING", "pending", "SOURCE_PENDING"],
		["EXTRACTING", "pending", "SOURCE_PENDING"],
		["FAILED", "failed", "EXTRACTION_FAILED"],
		["CANCELLED", "cancelled", "EXTRACTION_CANCELLED"],
	])(
		"never publishes retained text/hash while extraction is %s",
		(status, readiness, omissionReason) => {
			expect(build({ extractionStatus: status })).toMatchObject({
				readiness,
				omissionReason,
				revision: null,
				readUrl: null,
			});
		},
	);
	it("does not mistake a lifecycle-less integration's PENDING column for running extraction", () => {
		expect(
			build({
				type: "INTEGRATION",
				hasLifecycle: false,
				extractionStatus: "PENDING",
			}),
		).toMatchObject({ readiness: "ready", revision: hash });
	});
	it("does not masquerade a parent hash as a canonical crawl/bundle revision", () => {
		expect(build({ bodyKind: "composite" })).toMatchObject({
			readiness: "inspection_required",
			revision: null,
			byteLength: null,
			revisionReason: "CANONICAL_READ_REQUIRED",
			omissionReason: "CANONICAL_BODY_NOT_INSPECTED",
		});
	});
	it("omits over-limit read references rather than claiming the bounded inspector or unpinned legacy paging can return its revision", () => {
		expect(build({ byteLength: 98305 })).toMatchObject({
			readiness: "inspection_required",
			revision: null,
			readUrl: null,
			revisionReason: "DIRECT_READ_LIMIT_EXCEEDED",
			readTool: null,
		});
	});
	it("distinguishes private conversations from ordinary empty sources", () => {
		expect(
			build({ hasText: false, privateConversation: true }),
		).toMatchObject({
			readiness: "unavailable",
			omissionReason: "PRIVATE_CONVERSATION_EXCLUDED",
			revision: null,
		});
		expect(build({ hasText: false })).toMatchObject({
			omissionReason: "NO_READABLE_CONTENT",
		});
	});
	it("keeps STORE_ONLY direct content discoverable and refuses a bogus canonical hash", () => {
		expect(build({ indexingExcluded: true })).toMatchObject({
			indexingExcluded: true,
			readiness: "ready",
			revision: hash,
		});
		expect(() => build({ revision: null })).toThrow(
			"Invalid context manifest canonical revision",
		);
	});
});
