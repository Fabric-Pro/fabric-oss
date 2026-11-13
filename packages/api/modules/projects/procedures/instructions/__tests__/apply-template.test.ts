/**
 * `applyOrganizationInstructionTemplate` — "Start from the organization
 * template" and "Add files from the organization template" on the Coding
 * Instructions tab.
 *
 * The properties that must hold:
 *
 *  - the template is the one the TARGET project's own organization names,
 *    read tenant-scoped in that organization, never anything from the caller;
 *  - a repository-backed target, an open move, the template itself, a missing
 *    template and an unpublished one are all refused before a row is written;
 *  - a template row is copied only from the promoted key of its own snapshot;
 *  - the project wins every clash, and only missing paths become rows;
 *  - the bytes are copied inside storage into the same staging keys the
 *    browser would have uploaded to, and the version publishes itself on
 *    READY, never before its scan;
 *  - a failed copy closes the new row out.
 *
 * `@repo/instructions` is NOT mocked, so the real path, ignore and tree rules
 * decide what is skipped.
 */
import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	createDerivedInstructionSnapshot: vi.fn(),
	createInstructionSnapshot: vi.fn(),
	getInstructionSnapshot: vi.fn(),
	getProjectInstructionSettings: vi.fn(),
	getPublishedInstructionSnapshot: vi.fn(),
	listInstructionFiles: vi.fn(),
	getOrganizationInstructionTemplate: vi.fn(),
	claimInstructionFileStagingKey: vi.fn(),
	rejectAbandonedInstructionSnapshot: vi.fn(),
	requireHostingOrganizationId: vi.fn(),
	finalizeInstructionSnapshot: vi.fn(),
	migrationOpenError: vi.fn(),
	recordAuditFromRequest: vi.fn(),
	copyFile: vi.fn(),
	getFileMetadata: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	createDerivedInstructionSnapshot: (...a: unknown[]) =>
		m.createDerivedInstructionSnapshot(...a),
	createInstructionSnapshot: (...a: unknown[]) =>
		m.createInstructionSnapshot(...a),
	getInstructionSnapshot: (...a: unknown[]) => m.getInstructionSnapshot(...a),
	getProjectInstructionSettings: (...a: unknown[]) =>
		m.getProjectInstructionSettings(...a),
	getPublishedInstructionSnapshot: (...a: unknown[]) =>
		m.getPublishedInstructionSnapshot(...a),
	listInstructionFiles: (...a: unknown[]) => m.listInstructionFiles(...a),
	getOrganizationInstructionTemplate: (...a: unknown[]) =>
		m.getOrganizationInstructionTemplate(...a),
	claimInstructionFileStagingKey: (...a: unknown[]) =>
		m.claimInstructionFileStagingKey(...a),
	rejectAbandonedInstructionSnapshot: (...a: unknown[]) =>
		m.rejectAbandonedInstructionSnapshot(...a),
}));
vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({
		copyFile: m.copyFile,
		getFileMetadata: m.getFileMetadata,
	}),
}));
vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...a: unknown[]) => m.recordAuditFromRequest(...a),
}));
vi.mock("../hosting-organization", () => ({
	requireHostingOrganizationId: (...a: unknown[]) =>
		m.requireHostingOrganizationId(...a),
}));
// The workflow start is `finalize.ts`'s own, tested there.
vi.mock("../finalize", () => ({
	finalizeInstructionSnapshot: (...a: unknown[]) =>
		m.finalizeInstructionSnapshot(...a),
}));
vi.mock("../migration-freeze", () => ({
	migrationOpenError: (...a: unknown[]) => m.migrationOpenError(...a),
}));
vi.mock("../../../../../orpc/procedures", () => {
	const builder = {
		use: () => builder,
		route: () => builder,
		input: () => builder,
		handler: (fn: unknown) => fn,
	};
	return {
		tenantProtectedProcedure: builder,
		requireProjectPermission: () => ({}),
		Permissions: { INSTRUCTION_CREATE: "instruction:create" },
	};
});

import { applyOrganizationInstructionTemplate } from "../apply-template";

const PROJECT = "proj_target";
const TEMPLATE = "proj_template";
const ORG = "org_1";
const USER = "user_1";
const BASE_ID = "snap_base";
const TEMPLATE_SNAP = "snap_template";
const NEW_ID = "snap_new";
const audit = { user: { id: USER, email: "dev@example.com" } };

const templateKey = (fileId: string) =>
	`projects/${TEMPLATE}/instructions/snapshots/${TEMPLATE_SNAP}/${fileId}`;

function templateRow(id: string, path: string) {
	return {
		id,
		path,
		size: 12,
		sha256: "a".repeat(64),
		mimeType: "text/markdown",
		storageKey: templateKey(id),
	};
}

/** The new version's staged row, still on its provisional key. */
function stagedRow(id: string, path: string, index: number) {
	return {
		id,
		path,
		size: 12,
		sha256: "a".repeat(64),
		mimeType: "text/markdown",
		storageKey: `projects/${PROJECT}/instructions/staging/pending/${index}`,
	};
}

let templateRows: ReturnType<typeof templateRow>[];
let baseRows: Array<{ id: string; path: string }>;
let newRows: ReturnType<typeof stagedRow>[];

function apply() {
	return applyOrganizationInstructionTemplate({
		projectId: PROJECT,
		userId: USER,
		audit,
	});
}

beforeEach(() => {
	for (const fn of Object.values(m)) {
		fn.mockReset();
	}
	m.requireHostingOrganizationId.mockResolvedValue(ORG);
	m.getProjectInstructionSettings.mockResolvedValue({
		ignoreGlobs: null,
		sourceOfTruth: "UPLOAD",
		migration: null,
	});
	m.getOrganizationInstructionTemplate.mockResolvedValue({
		projectId: TEMPLATE,
		projectName: "Template",
		publishedSnapshotId: TEMPLATE_SNAP,
	});
	m.getPublishedInstructionSnapshot.mockResolvedValue({ id: BASE_ID });
	m.getInstructionSnapshot.mockImplementation(
		async (id: string, projectId: string, organizationId: string) => {
			if (organizationId !== ORG) {
				return null;
			}
			if (id === TEMPLATE_SNAP && projectId === TEMPLATE) {
				return {
					id: TEMPLATE_SNAP,
					status: "READY",
					contentKind: "FULL_SNAPSHOT",
					version: 4,
					fileCount: templateRows.length,
				};
			}
			if (id === BASE_ID && projectId === PROJECT) {
				return {
					id: BASE_ID,
					status: "READY",
					contentKind: "FULL_SNAPSHOT",
					version: 7,
					settingsFrozen: { layer: "default", ignoreGlobs: [] },
				};
			}
			return null;
		},
	);
	templateRows = [
		templateRow("tf_1", "CLAUDE.md"),
		templateRow("tf_2", "AGENTS.md"),
	];
	baseRows = [{ id: "bf_1", path: "CLAUDE.md" }];
	newRows = [stagedRow("nf_1", "AGENTS.md", 0)];
	m.listInstructionFiles.mockImplementation(async (snapshotId: string) => {
		if (snapshotId === TEMPLATE_SNAP) {
			return templateRows;
		}
		if (snapshotId === BASE_ID) {
			return baseRows;
		}
		if (snapshotId === NEW_ID) {
			return newRows;
		}
		return [];
	});
	m.createDerivedInstructionSnapshot.mockResolvedValue({
		ok: true,
		id: NEW_ID,
		version: 8,
		fileCount: 2,
		inheritedCount: 1,
		staged: [{ id: "nf_1", path: "AGENTS.md" }],
		auditWritten: false,
	});
	m.createInstructionSnapshot.mockResolvedValue({
		id: NEW_ID,
		version: 1,
		files: [{ id: "nf_1", path: "AGENTS.md", storageKey: "k" }],
		validationAttemptId: null,
	});
	m.claimInstructionFileStagingKey.mockResolvedValue({ moved: true });
	m.copyFile.mockResolvedValue(undefined);
	m.finalizeInstructionSnapshot.mockResolvedValue({ status: "VALIDATING" });
	m.rejectAbandonedInstructionSnapshot.mockResolvedValue({ changed: true });
});

describe("applyOrganizationInstructionTemplate", () => {
	it("derives a version from the published one holding only the template files the project lacks", async () => {
		const result = await apply();

		expect(m.createDerivedInstructionSnapshot).toHaveBeenCalledTimes(1);
		const call = m.createDerivedInstructionSnapshot.mock.calls[0]?.[0];
		expect(call).toMatchObject({
			projectId: PROJECT,
			organizationId: ORG,
			userId: USER,
			baseSnapshotId: BASE_ID,
			publishOnReady: true,
			proposal: false,
			baseKeyPrefix: `projects/${PROJECT}/instructions/snapshots/${BASE_ID}/`,
		});
		// Never published before its scan.
		expect(call).not.toHaveProperty("publishBeforeScan");
		expect(call.changes).toEqual([
			expect.objectContaining({ op: "put", path: "AGENTS.md" }),
		]);
		expect(m.createInstructionSnapshot).not.toHaveBeenCalled();
		expect(result).toEqual({
			snapshotId: NEW_ID,
			version: 8,
			added: 1,
			skipped: [{ path: "CLAUDE.md", reason: "exists" }],
		});
	});

	it("copies each template object inside storage into the row's real staging key, then starts the checks", async () => {
		await apply();

		const realKey = `projects/${PROJECT}/instructions/staging/${NEW_ID}/nf_1`;
		expect(m.claimInstructionFileStagingKey).toHaveBeenCalledWith(
			expect.objectContaining({
				fileId: "nf_1",
				snapshotId: NEW_ID,
				projectId: PROJECT,
				organizationId: ORG,
				to: realKey,
			}),
		);
		expect(m.copyFile).toHaveBeenCalledWith(
			templateKey("tf_2"),
			realKey,
			expect.objectContaining({ bucket: expect.any(String) }),
		);
		expect(m.finalizeInstructionSnapshot).toHaveBeenCalledWith({
			snapshot: { id: NEW_ID, status: "RECEIVING" },
			projectId: PROJECT,
			organizationId: ORG,
			userId: USER,
		});
		expect(m.copyFile.mock.invocationCallOrder[0]).toBeLessThan(
			m.finalizeInstructionSnapshot.mock.invocationCallOrder[0]!,
		);
	});

	it("audits the new version as an upload from the template, with counts only", async () => {
		await apply();

		expect(m.recordAuditFromRequest).toHaveBeenCalledTimes(1);
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			audit,
			expect.objectContaining({
				action: "project.instructions.upload_started",
				organizationId: ORG,
				projectId: PROJECT,
				resource: {
					type: "project_instruction_snapshot",
					id: NEW_ID,
					name: "v8",
				},
				metadata: expect.objectContaining({
					mode: "template",
					templateSnapshotId: TEMPLATE_SNAP,
					templateVersion: 4,
					keptCount: 1,
					skippedCount: 1,
					baseSnapshotId: BASE_ID,
				}),
			}),
		);
	});

	it("builds the project's first version under its live ignore rules when nothing is published", async () => {
		m.getPublishedInstructionSnapshot.mockResolvedValue(null);
		m.getProjectInstructionSettings.mockResolvedValue({
			ignoreGlobs: ["**/drafts/**"],
			sourceOfTruth: null,
			migration: null,
		});
		templateRows = [
			templateRow("tf_1", "AGENTS.md"),
			templateRow("tf_2", "drafts/idea.md"),
			templateRow("tf_3", ".fabricignore"),
		];

		const result = await apply();

		expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.createInstructionSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT,
				organizationId: ORG,
				source: "UPLOAD",
				publishOnReady: true,
				settingsFrozen: expect.objectContaining({
					ignoreGlobs: ["**/drafts/**"],
					layer: "project",
				}),
				excludedCount: 1,
				excludedPaths: [
					{ path: "drafts/idea.md", rule: "**/drafts/**" },
				],
				files: [
					expect.objectContaining({
						path: "AGENTS.md",
						storageKey: `projects/${PROJECT}/instructions/staging/pending/0`,
					}),
				],
			}),
		);
		expect(result).toEqual({
			snapshotId: NEW_ID,
			version: 1,
			added: 1,
			skipped: [
				{ path: "drafts/idea.md", reason: "excluded" },
				{ path: ".fabricignore", reason: "ignore_file" },
			],
		});
	});

	it("creates no version when the project already has every file the template could add", async () => {
		templateRows = [templateRow("tf_1", "CLAUDE.md")];

		const result = await apply();

		expect(result).toEqual({
			snapshotId: null,
			version: null,
			added: 0,
			skipped: [{ path: "CLAUDE.md", reason: "exists" }],
		});
		expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.createInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
		expect(m.copyFile).not.toHaveBeenCalled();
	});

	it("reads the template the target's own organization names, in that organization", async () => {
		await apply();

		expect(m.requireHostingOrganizationId).toHaveBeenCalledWith(
			PROJECT,
			USER,
		);
		expect(m.getOrganizationInstructionTemplate).toHaveBeenCalledWith(ORG);
		expect(m.getInstructionSnapshot).toHaveBeenCalledWith(
			TEMPLATE_SNAP,
			TEMPLATE,
			ORG,
		);
		expect(m.listInstructionFiles).toHaveBeenCalledWith(TEMPLATE_SNAP, ORG);
	});

	// A template id that names a project of ANOTHER organization finds no
	// snapshot under this organization's scope: nothing is copied.
	it("refuses a template whose version is not this organization's", async () => {
		m.getInstructionSnapshot.mockImplementation(
			async (id: string, projectId: string) =>
				id === BASE_ID && projectId === PROJECT
					? { id: BASE_ID, status: "READY", settingsFrozen: null }
					: null,
		);

		await expect(apply()).rejects.toMatchObject({
			code: "NOT_FOUND",
			data: { reason: "TEMPLATE_NOT_PUBLISHED" },
		});
		expect(m.listInstructionFiles).not.toHaveBeenCalled();
		expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("refuses when the organization has no template", async () => {
		m.getOrganizationInstructionTemplate.mockResolvedValue(null);

		await expect(apply()).rejects.toMatchObject({
			code: "NOT_FOUND",
			data: { reason: "NO_TEMPLATE" },
		});
		expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("refuses when the template has nothing published", async () => {
		m.getOrganizationInstructionTemplate.mockResolvedValue({
			projectId: TEMPLATE,
			projectName: "Template",
			publishedSnapshotId: null,
		});

		await expect(apply()).rejects.toMatchObject({
			code: "NOT_FOUND",
			data: { reason: "TEMPLATE_NOT_PUBLISHED" },
		});
	});

	it("refuses to copy the template into itself", async () => {
		m.getOrganizationInstructionTemplate.mockResolvedValue({
			projectId: PROJECT,
			projectName: "Template",
			publishedSnapshotId: BASE_ID,
		});

		await expect(apply()).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: { reason: "IS_TEMPLATE" },
		});
		expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("refuses a repository-backed project before reading the template", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			ignoreGlobs: null,
			sourceOfTruth: "REPOSITORY",
			migration: null,
		});

		await expect(apply()).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
		});
		expect(m.getOrganizationInstructionTemplate).not.toHaveBeenCalled();
	});

	it("refuses while a move into a repository is open", async () => {
		const migration = { state: "OPEN" };
		m.getProjectInstructionSettings.mockResolvedValue({
			ignoreGlobs: null,
			sourceOfTruth: "UPLOAD",
			migration,
		});
		m.migrationOpenError.mockResolvedValue(
			new ORPCError("CONFLICT", {
				message: "A move is open",
				data: { reason: "MIGRATION_OPEN" },
			}),
		);

		await expect(apply()).rejects.toMatchObject({
			code: "CONFLICT",
			data: { reason: "MIGRATION_OPEN" },
		});
		expect(m.migrationOpenError).toHaveBeenCalledWith(migration, {
			projectId: PROJECT,
			organizationId: ORG,
		});
		expect(m.getOrganizationInstructionTemplate).not.toHaveBeenCalled();
	});

	it("refuses a template row stored outside its own snapshot's promoted prefix", async () => {
		templateRows = [
			templateRow("tf_1", "CLAUDE.md"),
			{
				...templateRow("tf_2", "AGENTS.md"),
				storageKey:
					"projects/proj_other/instructions/snapshots/snap_x/tf_2",
			},
		];

		await expect(apply()).rejects.toMatchObject({
			code: "CONFLICT",
			data: { reason: "TEMPLATE_UNAVAILABLE" },
		});
		expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.copyFile).not.toHaveBeenCalled();
	});

	it("closes the new version out and reports a conflict when a template file vanished mid-copy", async () => {
		m.copyFile.mockRejectedValue(new Error("NoSuchKey"));
		m.getFileMetadata.mockResolvedValue(null);

		await expect(apply()).rejects.toMatchObject({
			code: "CONFLICT",
			data: { reason: "TEMPLATE_CHANGED" },
		});
		expect(m.getFileMetadata).toHaveBeenCalledWith(
			templateKey("tf_2"),
			expect.objectContaining({ bucket: expect.any(String) }),
		);
		expect(m.finalizeInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.rejectAbandonedInstructionSnapshot).toHaveBeenCalledWith({
			snapshotId: NEW_ID,
			projectId: PROJECT,
			organizationId: ORG,
			source: "template_copy_compensation",
		});
	});

	it("surfaces a storage failure as itself when the template file is still there, and still closes the version out", async () => {
		m.copyFile.mockRejectedValue(new Error("storage unavailable"));
		m.getFileMetadata.mockResolvedValue({ size: 12 });

		await expect(apply()).rejects.toThrow("storage unavailable");
		expect(m.rejectAbandonedInstructionSnapshot).toHaveBeenCalledTimes(1);
	});

	it("maps a refusal from the create transaction to the same error the tab's edits get", async () => {
		m.createDerivedInstructionSnapshot.mockResolvedValue({
			ok: false,
			reason: "base_not_published",
		});

		await expect(apply()).rejects.toMatchObject({
			code: "CONFLICT",
			data: { reason: "BASE_NOT_PUBLISHED" },
		});
		expect(m.copyFile).not.toHaveBeenCalled();
		expect(m.rejectAbandonedInstructionSnapshot).not.toHaveBeenCalled();
	});
});
