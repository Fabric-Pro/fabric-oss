/**
 * `submitInstructionChange`, with its authorization NOT mocked.
 *
 * Its sibling suite (`submit-change.test.ts`) stubs
 * `assertInstructionDeriveAccess` and `requireHostingOrganizationId` so it can
 * be about everything that happens after them. That is the right split, and it
 * leaves one thing unproven: that the refusals actually come out of the real
 * modules, in the real order, for the real permission.
 *
 * This file mocks only `resolveEffectiveProjectPermissions` — the single
 * database call both of those modules make — so a refusal here travels the
 * whole way through the code that ships. What it pins down is the split that
 * makes an API key safe to hand to a coding agent: the mode a caller asks for
 * decides which permission is demanded, `instructions:write` buys a PROPOSAL
 * and nothing more, and a publish is refused per call against a permission the
 * key's creator has to hold right now.
 */

import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	resolveEffectiveProjectPermissions: vi.fn(),
	getProjectInstructionSettings: vi.fn(),
	getPublishedInstructionSnapshot: vi.fn(),
	getInstructionSnapshot: vi.fn(),
	getInstructionSnapshotWithPublishedPointer: vi.fn(),
	createDerivedInstructionSnapshot: vi.fn(),
	listInstructionFiles: vi.fn(),
	claimInstructionFileStagingKey: vi.fn(),
	rejectAbandonedInstructionSnapshot: vi.fn(),
	recordAuditFromRequest: vi.fn(),
	finalizeInstructionSnapshot: vi.fn(),
	uploadFile: vi.fn(),
}));

vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...a: unknown[]) =>
		m.resolveEffectiveProjectPermissions(...a),
}));
vi.mock("@repo/database", () => ({
	getProjectInstructionSettings: (...a: unknown[]) =>
		m.getProjectInstructionSettings(...a),
	getPublishedInstructionSnapshot: (...a: unknown[]) =>
		m.getPublishedInstructionSnapshot(...a),
	getInstructionSnapshot: (...a: unknown[]) => m.getInstructionSnapshot(...a),
	getInstructionSnapshotWithPublishedPointer: (...a: unknown[]) =>
		m.getInstructionSnapshotWithPublishedPointer(...a),
	createDerivedInstructionSnapshot: (...a: unknown[]) =>
		m.createDerivedInstructionSnapshot(...a),
	listInstructionFiles: (...a: unknown[]) => m.listInstructionFiles(...a),
	claimInstructionFileStagingKey: (...a: unknown[]) =>
		m.claimInstructionFileStagingKey(...a),
	rejectAbandonedInstructionSnapshot: (...a: unknown[]) =>
		m.rejectAbandonedInstructionSnapshot(...a),
}));
vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({ uploadFile: m.uploadFile }),
}));
vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...a: unknown[]) => m.recordAuditFromRequest(...a),
}));
vi.mock("../finalize", () => ({
	finalizeInstructionSnapshot: (...a: unknown[]) =>
		m.finalizeInstructionSnapshot(...a),
}));

import { submitInstructionChange } from "../submit-change";

const PROJECT = "proj_1";
const ORG = "org_1";
const USER = "user_1";

function submit(overrides: Record<string, unknown> = {}) {
	return submitInstructionChange({
		userId: USER,
		projectId: PROJECT,
		baseSnapshotId: "snap_base",
		changes: [{ op: "put", path: "AGENTS.md", content: "# New\n" }],
		// Stated on every call, as the type demands. The tests that are about
		// the mode override it.
		mode: "proposal",
		audit: { user: { id: USER, email: "dev@example.com" } },
		via: "test",
		...overrides,
	} as Parameters<typeof submitInstructionChange>[0]);
}

/** A reader of this project: the ceiling an `instructions:write` key buys. */
function viewer() {
	return {
		source: "org",
		organizationId: ORG,
		permissions: [Permissions.INSTRUCTION_READ],
	};
}

/** Someone who may publish in the tab — the ceiling `instructions:publish` buys. */
function editor() {
	return {
		source: "org",
		organizationId: ORG,
		permissions: [
			Permissions.INSTRUCTION_READ,
			Permissions.INSTRUCTION_CREATE,
		],
	};
}

beforeEach(() => {
	for (const fn of Object.values(m)) {
		(fn as ReturnType<typeof vi.fn>).mockReset();
	}
	m.resolveEffectiveProjectPermissions.mockResolvedValue(viewer());
	m.getProjectInstructionSettings.mockResolvedValue({
		sourceOfTruth: "UPLOAD",
	});
	const base = {
		id: "snap_base",
		projectId: PROJECT,
		organizationId: ORG,
		status: "READY",
		version: 7,
		settingsFrozen: { layer: "default", ignoreGlobs: [] },
	};
	m.getPublishedInstructionSnapshot.mockResolvedValue(base);
	// The BASE the proposal is stated against, read before anything is
	// written.
	m.getInstructionSnapshot.mockResolvedValue(base);
	// The finalizer's re-read, AFTER the workflow ran: the new row plus the
	// project's published pointer, from one combined call. The pointer
	// defaults to the unchanged base — none of the tests here publish, so
	// nothing has moved it.
	m.getInstructionSnapshotWithPublishedPointer.mockResolvedValue({
		snapshot: {
			id: "snap_new",
			projectId: PROJECT,
			organizationId: ORG,
			version: 8,
			status: "VALIDATING",
			proposalStatus: "PENDING",
			baseVersion: 7,
			publishedAt: null,
		},
		publishedPointer: base,
	});
	m.createDerivedInstructionSnapshot.mockResolvedValue({
		ok: true,
		id: "snap_new",
		version: 8,
		fileCount: 3,
		inheritedCount: 2,
		staged: [{ id: "file_1", path: "AGENTS.md" }],
	});
	m.listInstructionFiles.mockResolvedValue([
		{
			id: "file_1",
			path: "AGENTS.md",
			storageKey: `projects/${PROJECT}/instructions/staging/pending/0`,
			mimeType: "text/markdown",
			size: 6,
		},
	]);
	m.claimInstructionFileStagingKey.mockResolvedValue({ moved: true });
	m.finalizeInstructionSnapshot.mockResolvedValue({ status: "VALIDATING" });
});

describe("the real permission check", () => {
	it("lets a reader propose", async () => {
		const result = await submit();

		expect(result.proposalStatus).toBe("PENDING");
		expect(m.createDerivedInstructionSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({ proposal: true, publishOnReady: false }),
		);
	});

	/**
	 * A caller who COULD publish in the tab still only proposes when that is
	 * what they asked for.
	 *
	 * The mode decides, never the permissions: the key minted for the proposal
	 * surfaces carries `instructions:write`, which is offered to read-only
	 * roles and described as review-gated, so what that key can do must not
	 * depend on who created it. This asks with the strongest permission set
	 * there is and still gets a proposal.
	 */
	it("still only proposes in proposal mode for a caller who could publish", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue(editor());

		const result = await submit();

		expect(result.mode).toBe("proposal");
		expect(result.proposalStatus).toBe("PENDING");
		expect(m.createDerivedInstructionSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({ proposal: true, publishOnReady: false }),
		);
	});

	it("still only proposes in proposal mode for the project's owner", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			source: "owner",
			organizationId: ORG,
			permissions: [],
		});

		const result = await submit();

		expect(result.proposalStatus).toBe("PENDING");
		expect(m.createDerivedInstructionSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({ publishOnReady: false }),
		);
	});

	/**
	 * Publish mode, and the permission it actually demands.
	 *
	 * `INSTRUCTION_CREATE` is what the Coding Instructions tab requires of the
	 * same person to put a version in front of everyone, and it is the live
	 * check a key never exceeds. The scope at the route (`instructions:publish`)
	 * is the ceiling; this is the floor.
	 */
	it("publishes for a caller who holds the publishing permission", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue(editor());

		const result = await submit({ mode: "publish" });

		expect(result.mode).toBe("publish");
		expect(m.createDerivedInstructionSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({ proposal: false, publishOnReady: true }),
		);
	});

	/**
	 * The refusal that makes the two scopes worth splitting.
	 *
	 * A reader — exactly what an `instructions:write` key's creator may be —
	 * can propose all day and cannot publish, and the refusal happens before
	 * any tenant data is read.
	 */
	it("refuses a publish from a caller who holds only INSTRUCTION_READ", async () => {
		await expect(submit({ mode: "publish" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(m.getProjectInstructionSettings).not.toHaveBeenCalled();
		expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
	});

	// Fail-closed on the mode itself: a JavaScript caller that forgets the
	// field, or sends one this file does not know, gets the REVIEWED path.
	// The dangerous direction would be the other one.
	it.each([[undefined], ["Publish"], ["direct"], [true]])(
		"treats a mode of %j as a proposal",
		async (mode) => {
			m.resolveEffectiveProjectPermissions.mockResolvedValue(editor());

			const result = await submit({ mode });

			expect(result.mode).toBe("proposal");
			expect(m.createDerivedInstructionSnapshot).toHaveBeenCalledWith(
				expect.objectContaining({
					proposal: true,
					publishOnReady: false,
				}),
			);
		},
	);

	// An invited project guest resolves through the project, not through an
	// organization membership; a caller with no tie at all resolves to null
	// and must be refused before anything is read.
	it("refuses a caller with no access to the project at all", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue(null);

		await expect(submit()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.getProjectInstructionSettings).not.toHaveBeenCalled();
	});

	// An organization is the only tenant context this feature supports, and
	// the null arm is fail-closed rather than a second tenancy branch.
	it("refuses a personal project after the permission check passes", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			source: "owner",
			organizationId: null,
			permissions: [],
		});

		await expect(submit()).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Coding instructions require an organization project",
		});
		expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
	});

	// There is no `organizationId` parameter, so the only organization this
	// can act in is the one the PROJECT resolves to.
	it("acts in the organization the project resolves to", async () => {
		await submit();

		expect(m.resolveEffectiveProjectPermissions).toHaveBeenCalledWith(
			PROJECT,
			USER,
		);
		expect(m.getInstructionSnapshot).toHaveBeenCalledWith(
			"snap_base",
			PROJECT,
			ORG,
		);
		expect(m.createDerivedInstructionSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: ORG }),
		);
	});
});
