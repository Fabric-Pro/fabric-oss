import { WorkspaceDocumentContentError } from "@repo/database/src/workspace-document-content";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createWorkspaceDocumentLinkCommands,
	type WorkspaceLinkDependencies,
} from "../commands";
import { WorkspaceLinkError } from "../contracts";

const actor = {
	userId: "example-user",
	organizationId: "example-org",
	projectId: "example-project",
};
const revision = "a".repeat(64);
const current = "b".repeat(64);
const row = {
	id: "example-link",
	organizationId: actor.organizationId,
	projectId: actor.projectId,
	documentId: "example-document",
	addedByUserId: actor.userId,
	sourceRevisionAtLink: revision,
	createdAt: new Date("2026-11-03T00:00:00Z"),
	updatedAt: new Date("2026-11-03T00:00:00Z"),
};
const doc = {
	id: row.documentId,
	workspaceId: "example-workspace",
	organizationId: actor.organizationId,
	filename: "Example private requirements",
	workspaceName: "Example private Workspace",
	status: "READY",
	revision,
	updatedAt: row.updatedAt,
};
const input = {
	workspaceId: doc.workspaceId,
	documentId: doc.id,
	expectedRevision: revision,
};
const deps = {
	authorizeProject: vi.fn(),
	authorizeWorkspace: vi.fn(),
	documents: vi.fn(),
	list: vi.fn(),
	get: vi.fn(),
	read: vi.fn(),
	add: vi.fn(),
	remove: vi.fn(),
};
const commands = createWorkspaceDocumentLinkCommands(
	deps as WorkspaceLinkDependencies,
);
beforeEach(() => {
	vi.resetAllMocks();
	deps.authorizeProject.mockResolvedValue(undefined);
	deps.authorizeWorkspace.mockResolvedValue(undefined);
	deps.documents.mockResolvedValue([doc]);
	deps.list.mockResolvedValue([row]);
	deps.get.mockResolvedValue(row);
	deps.read.mockResolvedValue({
		id: doc.id,
		workspaceId: doc.workspaceId,
		organizationId: actor.organizationId,
		text: "Example source text",
		revision,
		offset: 0,
		nextOffset: null,
	});
	deps.add.mockImplementation(async (_actor, _input, validate) => {
		await validate();
		return { linkId: row.id, created: true };
	});
	deps.remove.mockImplementation(async (_actor, _id, validate) => {
		await validate();
		return { removed: true };
	});
});
describe("Workspace document project links", () => {
	it("lists references with current rights/freshness and no source content or sharing grant", async () => {
		const result = await commands.list(actor, {});
		expect(result.links[0]).toMatchObject({
			id: row.id,
			filename: doc.filename,
			availability: "CURRENT",
			sharingGranted: false,
			indexedForProject: false,
			sourceRevision: revision,
		});
		expect(JSON.stringify(result)).not.toContain("Example source text");
		expect(deps.read).not.toHaveBeenCalled();
		expect(result.permissions).toEqual({ canAdd: true, canRemove: true });
	});
	it.each([
		["READY", current, "UPDATED"],
		["EXTRACTING", null, "PROCESSING"],
		["FAILED", null, "NEEDS_ATTENTION"],
		["READY", null, "NEEDS_ATTENTION"],
	])(
		"reports current %s source state",
		async (status, hash, availability) => {
			deps.documents.mockResolvedValue([
				{ ...doc, status, revision: hash },
			]);
			expect((await commands.list(actor, {})).links[0].availability).toBe(
				availability,
			);
		},
	);
	it("redacts unavailable source names/IDs/revisions and uses opaque link ID", async () => {
		deps.authorizeWorkspace.mockRejectedValue(
			new WorkspaceDocumentContentError("NOT_FOUND"),
		);
		const result = await commands.list(actor, {});
		expect(result.links).toEqual([
			{
				id: row.id,
				availability: "UNAVAILABLE",
				sourceKind: "workspace_document",
				contentRole: "reference_data",
				sharingGranted: false,
				indexedForProject: false,
			},
		]);
		expect(JSON.stringify(result)).not.toContain(doc.filename);
		expect(JSON.stringify(result)).not.toContain(doc.id);
		expect(JSON.stringify(result)).not.toContain(doc.workspaceId);
	});
	it("does not turn a systemic source authorization failure into an unavailable item", async () => {
		deps.authorizeWorkspace.mockRejectedValue(
			new Error("example-private-storage-detail"),
		);
		await expect(commands.list(actor, {})).rejects.toMatchObject({
			code: "UNAVAILABLE",
		});
	});
	it("invalidates the complete list when earlier Workspace rights are revoked while later work loads", async () => {
		deps.authorizeWorkspace
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(
				new WorkspaceDocumentContentError("FORBIDDEN"),
			);
		await expect(commands.list(actor, {})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
	it("rechecks project access after source metadata reads", async () => {
		deps.authorizeProject.mockImplementation(async (_actor, operation) => {
			if (operation === "read" && deps.documents.mock.calls.length) {
				throw new WorkspaceLinkError("NOT_FOUND");
			}
		});
		await expect(commands.list(actor, {})).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});
	it("reports read-only actions without permitting project writes", async () => {
		deps.authorizeProject.mockImplementation(async (_actor, operation) => {
			if (operation !== "read") {
				throw new WorkspaceLinkError("FORBIDDEN");
			}
		});
		expect((await commands.list(actor, {})).permissions).toEqual({
			canAdd: false,
			canRemove: false,
		});
		await expect(commands.add(actor, input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(deps.add).not.toHaveBeenCalled();
	});
	it("creates only an inspected same-org source reference, repeating exact pin at mutation", async () => {
		await commands.add(actor, input, "api_key");
		expect(deps.add).toHaveBeenCalledWith(
			actor,
			input,
			expect.any(Function),
			"api_key",
		);
		expect(deps.read).toHaveBeenCalledTimes(2);
		for (const call of deps.read.mock.calls) {
			expect(call[1]).toMatchObject({
				documentId: doc.id,
				workspaceId: doc.workspaceId,
				expectedRevision: revision,
				limit: 1,
			});
		}
	});
	it("returns idempotent unchanged links without rewriting reviewed revision", async () => {
		deps.add.mockImplementation(async () => ({
			linkId: row.id,
			created: false,
		}));
		expect(await commands.add(actor, input)).toEqual({
			linkId: row.id,
			created: false,
		});
	});
	it.each([
		{ ...doc, organizationId: "example-other-org" },
		{ ...doc, workspaceId: "example-other-workspace" },
	])(
		"refuses cross-organization or changed original Workspace before mutation",
		async (source) => {
			deps.documents.mockResolvedValue([source]);
			await expect(commands.add(actor, input)).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			expect(deps.add).not.toHaveBeenCalled();
		},
	);
	it.each(["STALE_REVISION", "NOT_READY", "FORBIDDEN"] as const)(
		"refuses %s source without mutation",
		async (code) => {
			deps.read.mockRejectedValue(
				new WorkspaceDocumentContentError(code),
			);
			await expect(commands.add(actor, input)).rejects.toMatchObject({
				code,
			});
			expect(deps.add).not.toHaveBeenCalled();
		},
	);
	it("revalidates a source whose revision changes at admission", async () => {
		deps.read
			.mockResolvedValueOnce({ revision })
			.mockRejectedValueOnce(
				new WorkspaceDocumentContentError("STALE_REVISION"),
			);
		await expect(commands.add(actor, input)).rejects.toMatchObject({
			code: "STALE_REVISION",
		});
	});
	it("can remove an unavailable reference without reading or deleting the source", async () => {
		deps.documents.mockRejectedValue(new Error("must not read"));
		expect(
			await commands.remove(actor, { linkId: row.id }, "agent"),
		).toEqual({ removed: true });
		expect(deps.documents).not.toHaveBeenCalled();
		expect(deps.read).not.toHaveBeenCalled();
		expect(deps.remove).toHaveBeenCalledWith(
			actor,
			row.id,
			expect.any(Function),
			"agent",
		);
	});
	it("does not expose text when the link is removed during the read", async () => {
		deps.get.mockResolvedValueOnce(row).mockResolvedValueOnce(null);
		await expect(
			commands.read(actor, { linkId: row.id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("does not expose text after current source or project permission revocation", async () => {
		deps.authorizeWorkspace.mockRejectedValue(
			new WorkspaceDocumentContentError("FORBIDDEN"),
		);
		await expect(
			commands.read(actor, { linkId: row.id }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("reads only a same-project reference and preserves current revision/code-point input", async () => {
		const result = await commands.read(actor, {
			linkId: row.id,
			offset: 5,
			limit: 10,
			expectedRevision: revision,
		});
		expect(deps.read).toHaveBeenCalledWith(actor, {
			workspaceId: doc.workspaceId,
			documentId: doc.id,
			offset: 5,
			limit: 10,
			expectedRevision: revision,
		});
		expect(result).toMatchObject({
			projectId: actor.projectId,
			linkId: row.id,
			contentRole: "reference_data",
			sharingGranted: false,
		});
	});
	it("refuses missing or other-project links before any source lookup", async () => {
		deps.get.mockResolvedValue(null);
		await expect(
			commands.read(actor, { linkId: "example-other-link" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(deps.documents).not.toHaveBeenCalled();
	});
	it("keeps live-offset pagination bounded and does not derive counts from hidden source bodies", async () => {
		deps.list.mockResolvedValue([row, { ...row, id: "example-next-link" }]);
		const result = await commands.list(actor, { limit: 1, offset: 0 });
		expect(result.links).toHaveLength(1);
		expect(result.nextOffset).toBe(1);
		expect(deps.list).toHaveBeenCalledWith(actor, { limit: 2, offset: 0 });
	});
	it.each([
		{ ...input, userId: "example-other" },
		{ ...input, expectedRevision: "bad" },
		{ ...input, organizationId: "example-other-org" },
	])("rejects actor overrides and invalid pins", async (value) => {
		await expect(commands.add(actor, value)).rejects.toMatchObject({
			code: "INVALID_INPUT",
		});
		expect(deps.add).not.toHaveBeenCalled();
	});
	it("fences a document moved or changed after the canonical read", async () => {
		deps.documents
			.mockResolvedValueOnce([doc])
			.mockResolvedValueOnce([
				{ ...doc, workspaceId: "example-new-private-workspace" },
			]);
		await expect(
			commands.read(actor, { linkId: row.id }),
		).rejects.toMatchObject({ code: "STALE_REVISION" });
	});
	it("fences metadata that changes while source permissions are checked", async () => {
		deps.documents
			.mockResolvedValueOnce([doc])
			.mockResolvedValueOnce([{ ...doc, revision: current }]);
		await expect(commands.list(actor, {})).rejects.toMatchObject({
			code: "STALE_REVISION",
		});
	});
	it("passes the mutation transaction through every project/source validation", async () => {
		const tx = { exampleTransaction: true };
		deps.add.mockImplementation(async (_actor, _input, validate) => {
			await validate(tx);
			return { linkId: row.id, created: true };
		});
		await commands.add(actor, input);
		expect(deps.authorizeProject).toHaveBeenCalledWith(actor, "link", tx);
		expect(deps.documents).toHaveBeenCalledWith(actor, [doc.id], tx);
		expect(deps.authorizeWorkspace).toHaveBeenCalledWith(
			actor,
			doc.workspaceId,
			tx,
		);
		expect(deps.read).toHaveBeenCalledWith(
			actor,
			expect.objectContaining({ expectedRevision: revision }),
			tx,
		);
	});
});
