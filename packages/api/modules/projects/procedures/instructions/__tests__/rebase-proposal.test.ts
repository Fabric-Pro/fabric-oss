/**
 * `rebaseInstructionProposal`: the proposer's rebase of a stale upload-mode
 * proposal onto the version now published.
 *
 * `@repo/instructions` is NOT mocked, so the merge under test is the real
 * one. `submitInstructionChange` is the seam: its own suite covers the
 * validation, scan and atomic close it performs with `supersedes`, and here
 * the question is what this file hands it, and that a conflict hands it
 * nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handlers: {} as Record<
		string,
		(arg: {
			input: Record<string, unknown>;
			context: unknown;
		}) => Promise<unknown>
	>,
	getInstructionProposal: vi.fn(),
	getInstructionSnapshot: vi.fn(),
	getPublishedInstructionSnapshot: vi.fn(),
	listInstructionFiles: vi.fn(),
	downloadFile: vi.fn(),
	requireHostingOrganizationId: vi.fn(),
	assertNoOpenMigration: vi.fn(),
	submitInstructionChange: vi.fn(),
	requiredPermissions: [] as string[],
}));

vi.mock("@repo/database", () => ({
	getInstructionProposal: (...a: unknown[]) => m.getInstructionProposal(...a),
	getInstructionSnapshot: (...a: unknown[]) => m.getInstructionSnapshot(...a),
	getPublishedInstructionSnapshot: (...a: unknown[]) =>
		m.getPublishedInstructionSnapshot(...a),
	listInstructionFiles: (...a: unknown[]) => m.listInstructionFiles(...a),
}));
vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({ downloadFile: m.downloadFile }),
}));
vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { skills: "skills" } } },
}));
vi.mock("../../../../../lib/audit", () => ({
	resolveActor: (context: { user: { id: string } }) => ({
		type: "user",
		userId: context.user.id,
	}),
	auditRequestFields: () => ({
		impersonatedById: null,
		ipAddress: "203.0.113.7",
		userAgent: null,
		requestId: "req_1",
		sessionId: "sess_1",
		correlationId: "corr_1",
	}),
}));
vi.mock("../hosting-organization", () => ({
	requireHostingOrganizationId: (...a: unknown[]) =>
		m.requireHostingOrganizationId(...a),
}));
vi.mock("../migration-freeze", () => ({
	assertNoOpenMigration: (...a: unknown[]) => m.assertNoOpenMigration(...a),
}));
vi.mock("../submit-change", () => ({
	submitInstructionChange: (...a: unknown[]) =>
		m.submitInstructionChange(...a),
}));
vi.mock("../../../../../orpc/procedures", () => {
	let currentPath = "";
	const builder = {
		use: () => builder,
		route: (route: { path: string }) => {
			currentPath = route.path;
			return builder;
		},
		input: () => builder,
		handler: (
			fn: (arg: {
				input: Record<string, unknown>;
				context: unknown;
			}) => Promise<unknown>,
		) => {
			m.handlers[currentPath] = fn;
			return fn;
		},
	};
	return {
		tenantProtectedProcedure: builder,
		requireProjectPermission: (permission: string) => {
			m.requiredPermissions.push(permission);
			return {};
		},
		Permissions: { INSTRUCTION_READ: "instruction:read" },
	};
});

import { rebaseInstructionProposal } from "../rebase-proposal";

const REBASE = "/projects/:projectId/instructions/proposals/:snapshotId/rebase";
const PROJECT = "proj_1";
const ORG = "org_1";
const PROPOSER = "user_1";
const context = {
	user: { id: PROPOSER, email: "dev@example.com", name: "Dev" },
};

type File = { path: string; text: string; binary?: boolean };

const objects = new Map<string, Buffer>();

function filesOf(snapshot: string, files: File[]) {
	return files.map((file) => {
		const key = `${snapshot}/${file.path}`;
		objects.set(key, Buffer.from(file.text, "utf8"));
		return {
			id: `${snapshot}:${file.path}`,
			path: file.path,
			sha256: `sha:${file.text}`,
			isText: !file.binary,
			storageKey: key,
		};
	});
}

function proposal(overrides: Record<string, unknown> = {}) {
	return {
		id: "snap_proposal",
		version: 7,
		contentKind: "FULL_SNAPSHOT",
		proposalDestination: "FABRIC",
		proposalStatus: "PENDING",
		status: "READY",
		isStale: true,
		baseSnapshotId: "snap_base",
		proposalNote: { title: "Tighten the review rules" },
		...overrides,
	};
}

function arrange(input: { base: File[]; ours: File[]; theirs: File[] }) {
	objects.clear();
	const lists: Record<string, ReturnType<typeof filesOf>> = {
		snap_base: filesOf("snap_base", input.base),
		snap_proposal: filesOf("snap_proposal", input.ours),
		snap_published: filesOf("snap_published", input.theirs),
	};
	m.listInstructionFiles.mockImplementation(async (id: string) => lists[id]);
}

function rebase(resolutions: unknown[] = []) {
	return rebaseInstructionProposal({
		userId: PROPOSER,
		projectId: PROJECT,
		snapshotId: "snap_proposal",
		resolutions: resolutions as never,
		audit: context,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	m.requireHostingOrganizationId.mockResolvedValue(ORG);
	m.assertNoOpenMigration.mockResolvedValue(undefined);
	m.getInstructionProposal
		.mockResolvedValueOnce(proposal())
		.mockResolvedValue(proposal({ proposalStatus: "REJECTED" }));
	m.getPublishedInstructionSnapshot.mockResolvedValue({
		id: "snap_published",
	});
	m.getInstructionSnapshot.mockImplementation(async (id: string) => ({
		id,
		status: "READY",
		version: id === "snap_base" ? 6 : 8,
	}));
	m.downloadFile.mockImplementation(async (key: string) => ({
		data: objects.get(key),
	}));
	m.submitInstructionChange.mockResolvedValue({
		snapshotId: "snap_rebased",
		version: 9,
		baseVersion: 8,
		putCount: 2,
		deleteCount: 1,
	});
});

describe("rebaseInstructionProposal", () => {
	it("is reached through a route gated on instruction:read", () => {
		expect(m.handlers[REBASE]).toBeTypeOf("function");
		expect(m.requiredPermissions).toContain("instruction:read");
	});

	it("reads only the caller's own proposal, so another member's id is not found", async () => {
		m.getInstructionProposal.mockReset().mockResolvedValue(null);

		await expect(rebase()).rejects.toMatchObject({
			code: "NOT_FOUND",
			data: { reason: "PROPOSAL_NOT_FOUND" },
		});

		expect(m.getInstructionProposal).toHaveBeenCalledWith(
			"snap_proposal",
			PROJECT,
			ORG,
			{ proposerUserId: PROPOSER },
		);
		expect(m.submitInstructionChange).not.toHaveBeenCalled();
	});

	it.each([
		["a pull-request proposal", { proposalDestination: "REPOSITORY" }],
		["a Git-intent proposal", { contentKind: "GIT_INTENT" }],
	])("refuses %s as unsupported", async (_name, overrides) => {
		m.getInstructionProposal
			.mockReset()
			.mockResolvedValue(proposal(overrides));

		await expect(rebase()).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			data: { reason: "REBASE_UNSUPPORTED" },
		});
		expect(m.listInstructionFiles).not.toHaveBeenCalled();
	});

	it.each([
		["one that is not stale", { isStale: false }, "PROPOSAL_NOT_STALE"],
		["a decided one", { proposalStatus: "REJECTED" }, "REBASE_UNAVAILABLE"],
		[
			"one still being checked",
			{ status: "VALIDATING" },
			"PROPOSAL_IN_PROGRESS",
		],
	])("refuses %s", async (_name, overrides, reason) => {
		m.getInstructionProposal
			.mockReset()
			.mockResolvedValue(proposal(overrides));

		await expect(rebase()).rejects.toMatchObject({
			code: "CONFLICT",
			data: { reason },
		});
		expect(m.submitInstructionChange).not.toHaveBeenCalled();
	});

	it("refuses while a move into the repository is open, before reading anything", async () => {
		m.assertNoOpenMigration.mockRejectedValue(new Error("MIGRATION_OPEN"));

		await expect(rebase()).rejects.toThrow("MIGRATION_OPEN");
		expect(m.getInstructionProposal).not.toHaveBeenCalled();
	});

	it("refuses when the proposal's base is no longer kept", async () => {
		m.getInstructionProposal
			.mockReset()
			.mockResolvedValue(proposal({ baseSnapshotId: null }));

		await expect(rebase()).rejects.toMatchObject({
			data: { reason: "REBASE_BASE_UNAVAILABLE" },
		});
	});

	it("proposes the merged change on the published version and replaces the stale proposal", async () => {
		arrange({
			base: [
				{ path: "AGENTS.md", text: "one\ntwo\nthree\n" },
				{ path: "old.md", text: "x\n" },
				{ path: "shared.md", text: "keep\n" },
			],
			ours: [
				{ path: "AGENTS.md", text: "ONE\ntwo\nthree\n" },
				{ path: "shared.md", text: "keep\n" },
				{ path: "new.md", text: "added\n" },
			],
			theirs: [
				{ path: "AGENTS.md", text: "one\ntwo\nTHREE\n" },
				{ path: "old.md", text: "x\n" },
				{ path: "shared.md", text: "changed upstream\n" },
			],
		});

		await expect(rebase()).resolves.toEqual({
			outcome: "rebased",
			snapshotId: "snap_rebased",
			version: 9,
			baseVersion: 8,
			putCount: 2,
			deleteCount: 1,
		});

		const call = m.submitInstructionChange.mock.calls[0]?.[0];
		expect(call).toMatchObject({
			userId: PROPOSER,
			projectId: PROJECT,
			baseSnapshotId: "snap_published",
			mode: "proposal",
			note: { title: "Tighten the review rules" },
			via: "rebase",
			supersedes: { snapshotId: "snap_proposal" },
		});
		expect(call.changes).toEqual([
			{
				op: "put",
				path: "AGENTS.md",
				content: "ONE\ntwo\nTHREE\n",
				encoding: "utf8",
			},
			{
				op: "put",
				path: "new.md",
				content: Buffer.from("added\n").toString("base64"),
				encoding: "base64",
			},
			{ op: "delete", path: "old.md" },
		]);
		expect(
			call.supersedes.audit({ id: "snap_rebased", version: 9 }),
		).toMatchObject({
			action: "project.instructions.proposal_rebased",
			organizationId: ORG,
			projectId: PROJECT,
			resource: { id: "snap_proposal", name: "v7" },
			metadata: {
				rebasedSnapshotId: "snap_rebased",
				rebasedVersion: 9,
				fromBaseVersion: 6,
				toBaseVersion: 8,
				changeCount: 3,
			},
		});
		expect(
			JSON.stringify(call.supersedes.audit({ id: "x", version: 1 })),
		).not.toContain("AGENTS.md");
	});

	it("returns the conflicts with their markers and writes nothing", async () => {
		arrange({
			base: [
				{ path: "AGENTS.md", text: "a\nb\nc\n" },
				{ path: "logo.png", text: "png-1", binary: true },
				{ path: "gone.md", text: "g\n" },
				{ path: "ok.md", text: "1\n" },
			],
			ours: [
				{ path: "AGENTS.md", text: "a\nours\nc\n" },
				{ path: "logo.png", text: "png-2", binary: true },
				{ path: "ok.md", text: "2\n" },
			],
			theirs: [
				{ path: "AGENTS.md", text: "a\ntheirs\nc\n" },
				{ path: "logo.png", text: "png-3", binary: true },
				{ path: "gone.md", text: "edited\n" },
				{ path: "ok.md", text: "1\n" },
			],
		});

		const result = await rebase();

		expect(result).toEqual({
			outcome: "conflicts",
			publishedSnapshotId: "snap_published",
			publishedVersion: 8,
			conflicts: [
				{
					path: "AGENTS.md",
					reason: "content",
					text: "a\n<<<<<<< your proposal (version 7)\nours\n=======\ntheirs\n>>>>>>> published (version 8)\nc\n",
				},
				{
					path: "gone.md",
					reason: "delete-edit",
					text: "<<<<<<< your proposal (version 7)\n=======\nedited\n>>>>>>> published (version 8)\n",
				},
				{ path: "logo.png", reason: "binary", text: null },
			],
			clean: [{ path: "ok.md", op: "put" }],
		});
		expect(m.submitInstructionChange).not.toHaveBeenCalled();
	});

	it("carries the proposer's resolutions and refuses one that still holds markers", async () => {
		const files = {
			base: [{ path: "AGENTS.md", text: "a\nb\nc\n" }],
			ours: [{ path: "AGENTS.md", text: "a\nours\nc\n" }],
			theirs: [{ path: "AGENTS.md", text: "a\ntheirs\nc\n" }],
		};
		arrange(files);

		await expect(
			rebase([
				{
					op: "put",
					path: "AGENTS.md",
					content:
						"a\n<<<<<<< mine\nours\n=======\ntheirs\n>>>>>>> theirs\nc\n",
				},
			]),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { reason: "UNRESOLVED_CONFLICT_MARKERS", path: "AGENTS.md" },
		});
		expect(m.submitInstructionChange).not.toHaveBeenCalled();

		arrange(files);
		m.getInstructionProposal
			.mockReset()
			.mockResolvedValueOnce(proposal())
			.mockResolvedValue(proposal({ proposalStatus: "REJECTED" }));
		await rebase([
			{ op: "put", path: "AGENTS.md", content: "a\nboth\nc\n" },
		]);
		expect(m.submitInstructionChange.mock.calls[0]?.[0].changes).toEqual([
			{
				op: "put",
				path: "AGENTS.md",
				content: "a\nboth\nc\n",
				encoding: "utf8",
			},
		]);
	});

	it("keeps the published version of a conflicting file when the proposer chooses it", async () => {
		arrange({
			base: [
				{ path: "logo.png", text: "png-1", binary: true },
				{ path: "AGENTS.md", text: "a\n" },
			],
			ours: [
				{ path: "logo.png", text: "png-2", binary: true },
				{ path: "AGENTS.md", text: "b\n" },
			],
			theirs: [
				{ path: "logo.png", text: "png-3", binary: true },
				{ path: "AGENTS.md", text: "a\n" },
			],
		});

		await rebase([{ op: "published", path: "logo.png" }]);

		expect(m.submitInstructionChange.mock.calls[0]?.[0].changes).toEqual([
			{
				op: "put",
				path: "AGENTS.md",
				content: Buffer.from("b\n").toString("base64"),
				encoding: "base64",
			},
		]);
	});

	it("refuses a resolution for a file that has no conflict", async () => {
		arrange({
			base: [{ path: "AGENTS.md", text: "a\n" }],
			ours: [{ path: "AGENTS.md", text: "b\n" }],
			theirs: [{ path: "AGENTS.md", text: "a\n" }],
		});

		await expect(
			rebase([{ op: "put", path: "README.md", content: "sneaked in\n" }]),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { reason: "RESOLUTION_NOT_A_CONFLICT" },
		});
		expect(m.submitInstructionChange).not.toHaveBeenCalled();
	});

	it("refuses a rebase that would leave nothing to propose", async () => {
		arrange({
			base: [{ path: "AGENTS.md", text: "a\n" }],
			ours: [{ path: "AGENTS.md", text: "b\n" }],
			theirs: [{ path: "AGENTS.md", text: "b\n" }],
		});

		await expect(rebase()).rejects.toMatchObject({
			code: "CONFLICT",
			data: { reason: "REBASE_NOTHING_LEFT" },
		});
		expect(m.submitInstructionChange).not.toHaveBeenCalled();
	});

	it("reports an identical rebase already proposed as a duplicate, leaving the stale proposal pending", async () => {
		arrange({
			base: [{ path: "AGENTS.md", text: "a\n" }],
			ours: [{ path: "AGENTS.md", text: "b\n" }],
			theirs: [{ path: "AGENTS.md", text: "a\n" }],
		});
		m.getInstructionProposal.mockReset().mockResolvedValue(proposal());

		await expect(rebase()).resolves.toEqual({
			outcome: "duplicate",
			snapshotId: "snap_rebased",
			version: 9,
		});
	});
});
