/**
 * `projects.instructions.getDigest` / `markSeen`: what changed since the
 * caller last looked at the Coding Instructions tab, and the marker it reads.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handlers: {} as Record<string, (...a: unknown[]) => unknown>,
	currentPath: "",
	getInstructionSeenMarker: vi.fn(),
	getPublishedInstructionSnapshot: vi.fn(),
	getInstructionSnapshot: vi.fn(),
	findReadableInstructionVersion: vi.fn(),
	listInstructionVersionsPublishedSince: vi.fn(),
	listInstructionProposalsResolvedSince: vi.fn(),
	recordInstructionSeen: vi.fn(),
	compareInstructionVersions: vi.fn(),
	canReviewInstructionProposals: vi.fn(),
	requireHostingOrganizationId: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getInstructionSeenMarker: (...a: unknown[]) =>
		m.getInstructionSeenMarker(...a),
	getPublishedInstructionSnapshot: (...a: unknown[]) =>
		m.getPublishedInstructionSnapshot(...a),
	getInstructionSnapshot: (...a: unknown[]) => m.getInstructionSnapshot(...a),
	findReadableInstructionVersion: (...a: unknown[]) =>
		m.findReadableInstructionVersion(...a),
	listInstructionVersionsPublishedSince: (...a: unknown[]) =>
		m.listInstructionVersionsPublishedSince(...a),
	listInstructionProposalsResolvedSince: (...a: unknown[]) =>
		m.listInstructionProposalsResolvedSince(...a),
	recordInstructionSeen: (...a: unknown[]) => m.recordInstructionSeen(...a),
}));
vi.mock("../compare-core", () => ({
	compareInstructionVersions: (...a: unknown[]) =>
		m.compareInstructionVersions(...a),
}));
vi.mock("../hosting-organization", () => ({
	requireHostingOrganizationId: (...a: unknown[]) =>
		m.requireHostingOrganizationId(...a),
}));
vi.mock("../proposal-authorization", async (importOriginal) => ({
	...(await importOriginal<typeof import("../proposal-authorization")>()),
	canReviewInstructionProposals: (...a: unknown[]) =>
		m.canReviewInstructionProposals(...a),
}));
vi.mock("../../../../../orpc/middleware/project-visibility", () => ({
	projectNotFoundUnlessVisible: {},
}));
vi.mock("../../../../../orpc/procedures", () => {
	const b = {
		use: () => b,
		route: (route: { path: string }) => {
			m.currentPath = route.path;
			return b;
		},
		input: () => b,
		handler: (fn: (...a: unknown[]) => unknown) => {
			m.handlers[m.currentPath] = fn;
			return fn;
		},
	};
	return {
		tenantProtectedProcedure: b,
		requireProjectPermission: () => ({}),
		Permissions: { INSTRUCTION_READ: "instruction:read" },
	};
});

import "../digest";

const DIGEST = "/projects/:projectId/instructions/digest";
const SEEN = "/projects/:projectId/instructions/seen";
const ctx = { user: { id: "reader_1" } };
const seenAt = new Date("2026-10-01T00:00:00Z");
const readable = (id: string, version: number) => ({
	id,
	version,
	contentKind: "FULL_SNAPSHOT",
	status: "READY",
	proposalStatus: null,
	proposalDestination: "FABRIC",
});

beforeEach(() => {
	for (const value of Object.values(m)) {
		if (typeof value === "function" && "mockReset" in value) {
			(value as ReturnType<typeof vi.fn>).mockReset();
		}
	}
	m.requireHostingOrganizationId.mockResolvedValue("org_1");
	m.canReviewInstructionProposals.mockResolvedValue(false);
	m.getPublishedInstructionSnapshot.mockResolvedValue({
		id: "s5",
		version: 5,
	});
	m.listInstructionVersionsPublishedSince.mockResolvedValue([]);
	m.listInstructionProposalsResolvedSince.mockResolvedValue([]);
	m.compareInstructionVersions.mockResolvedValue({
		added: [],
		removed: [],
		changed: [{ path: "CLAUDE.md" }],
		unchangedCount: 3,
	});
});

describe("projects.instructions.getDigest", () => {
	it("shows no digest on a first visit and writes nothing", async () => {
		m.getInstructionSeenMarker.mockResolvedValue(null);

		const result = await m.handlers[DIGEST]!({
			input: { projectId: "p" },
			context: ctx,
		});

		expect(result).toMatchObject({
			firstVisit: true,
			hasChanges: false,
			current: { snapshotId: "s5", version: 5 },
		});
		expect(m.recordInstructionSeen).not.toHaveBeenCalled();
		expect(m.compareInstructionVersions).not.toHaveBeenCalled();
	});

	it("compares the version they saw with the published one, tenant-scoped, and narrows proposals for a non-reviewer", async () => {
		m.getInstructionSeenMarker.mockResolvedValue({
			snapshotId: "s3",
			version: 3,
			seenAt,
		});
		m.getInstructionSnapshot.mockResolvedValue(readable("s3", 3));
		m.listInstructionVersionsPublishedSince.mockResolvedValue([
			{
				id: "s5",
				version: 5,
				source: "REPOSITORY",
				sourceRef: "main",
				sourceCommitSha: "0123456789",
				publishedAt: seenAt,
				user: { id: "u2", name: "Example" },
			},
		]);

		const result = await m.handlers[DIGEST]!({
			input: { projectId: "p" },
			context: ctx,
		});

		expect(m.getInstructionSnapshot).toHaveBeenCalledWith(
			"s3",
			"p",
			"org_1",
		);
		expect(m.compareInstructionVersions).toHaveBeenCalledWith({
			fromSnapshotId: "s3",
			toSnapshotId: "s5",
			organizationId: "org_1",
		});
		expect(m.listInstructionProposalsResolvedSince).toHaveBeenCalledWith({
			projectId: "p",
			organizationId: "org_1",
			since: seenAt,
			proposerUserId: "reader_1",
		});
		expect(result).toMatchObject({
			firstVisit: false,
			hasChanges: true,
			seen: { version: 3, comparable: true },
			versions: [
				{ version: 5, sourceRef: "main", shortCommitSha: "0123456" },
			],
			paths: { changed: [{ path: "CLAUDE.md" }] },
		});
	});

	it("falls back to the stored version number when the seen snapshot was pruned", async () => {
		m.getInstructionSeenMarker.mockResolvedValue({
			snapshotId: "gone",
			version: 3,
			seenAt,
		});
		m.getInstructionSnapshot.mockResolvedValue(null);
		m.findReadableInstructionVersion.mockResolvedValue({
			id: "s3b",
			version: 3,
		});

		await m.handlers[DIGEST]!({ input: { projectId: "p" }, context: ctx });

		expect(m.findReadableInstructionVersion).toHaveBeenCalledWith({
			projectId: "p",
			organizationId: "org_1",
			version: 3,
		});
		expect(m.compareInstructionVersions).toHaveBeenCalledWith(
			expect.objectContaining({ fromSnapshotId: "s3b" }),
		);
	});

	it("lists only versions and proposals when the seen version is gone entirely", async () => {
		m.getInstructionSeenMarker.mockResolvedValue({
			snapshotId: "gone",
			version: 3,
			seenAt,
		});
		m.getInstructionSnapshot.mockResolvedValue(null);
		m.findReadableInstructionVersion.mockResolvedValue(null);

		const result = await m.handlers[DIGEST]!({
			input: { projectId: "p" },
			context: ctx,
		});

		expect(m.compareInstructionVersions).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			hasChanges: true,
			paths: null,
			seen: { comparable: false },
		});
	});

	it("bounds the listed versions by the one published now, so a rolled-back newer version does not bring the digest back", async () => {
		m.getPublishedInstructionSnapshot.mockResolvedValue({
			id: "s8",
			version: 8,
		});
		m.getInstructionSeenMarker.mockResolvedValue({
			snapshotId: "s8",
			version: 8,
			seenAt,
		});
		m.getInstructionSnapshot.mockResolvedValue(readable("s8", 8));
		// The real read keeps only versions within the bound it is given.
		const rolledBack = [9, 10].map((version) => ({
			id: `s${version}`,
			version,
			source: "REPOSITORY",
			sourceRef: "main",
			sourceCommitSha: null,
			publishedAt: seenAt,
			user: { id: "u2", name: "Example" },
		}));
		m.listInstructionVersionsPublishedSince.mockImplementation(
			async (i: { throughVersion: number | null }) =>
				rolledBack.filter(
					(row) =>
						i.throughVersion === null ||
						row.version <= i.throughVersion,
				),
		);

		const result = await m.handlers[DIGEST]!({
			input: { projectId: "p" },
			context: ctx,
		});

		expect(m.listInstructionVersionsPublishedSince).toHaveBeenCalledWith({
			projectId: "p",
			organizationId: "org_1",
			afterVersion: 8,
			throughVersion: 8,
		});
		expect(result).toMatchObject({ hasChanges: false, versions: [] });
	});

	it("puts no upper bound on the listed versions when nothing is published", async () => {
		m.getPublishedInstructionSnapshot.mockResolvedValue(null);
		m.getInstructionSeenMarker.mockResolvedValue({
			snapshotId: null,
			version: null,
			seenAt,
		});

		await m.handlers[DIGEST]!({ input: { projectId: "p" }, context: ctx });

		expect(m.listInstructionVersionsPublishedSince).toHaveBeenCalledWith(
			expect.objectContaining({ afterVersion: 0, throughVersion: null }),
		);
	});

	it("reports nothing new when the pointer is where they left it", async () => {
		m.getInstructionSeenMarker.mockResolvedValue({
			snapshotId: "s5",
			version: 5,
			seenAt,
		});
		m.getInstructionSnapshot.mockResolvedValue(readable("s5", 5));
		m.canReviewInstructionProposals.mockResolvedValue(true);

		const result = await m.handlers[DIGEST]!({
			input: { projectId: "p" },
			context: ctx,
		});

		expect(result).toMatchObject({ hasChanges: false, paths: null });
		// A reviewer sees every decided proposal.
		expect(m.listInstructionProposalsResolvedSince).toHaveBeenCalledWith(
			expect.not.objectContaining({ proposerUserId: expect.anything() }),
		);
	});
});

describe("projects.instructions.markSeen", () => {
	it("records the version the caller was shown, with its number", async () => {
		m.getInstructionSnapshot.mockResolvedValue(readable("s5", 5));

		await m.handlers[SEEN]!({
			input: { projectId: "p", snapshotId: "s5" },
			context: ctx,
		});

		expect(m.recordInstructionSeen).toHaveBeenCalledWith({
			projectId: "p",
			userId: "reader_1",
			organizationId: "org_1",
			snapshotId: "s5",
			version: 5,
		});
	});

	it("refuses a snapshot the caller may not read as a version, writing nothing", async () => {
		m.getInstructionSnapshot.mockResolvedValue({
			...readable("p9", 9),
			proposalStatus: "PENDING",
		});

		await expect(
			m.handlers[SEEN]!({
				input: { projectId: "p", snapshotId: "p9" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.recordInstructionSeen).not.toHaveBeenCalled();
	});

	it("records 'nothing published yet' as a null marker", async () => {
		await m.handlers[SEEN]!({
			input: { projectId: "p", snapshotId: null },
			context: ctx,
		});

		expect(m.recordInstructionSeen).toHaveBeenCalledWith(
			expect.objectContaining({ snapshotId: null, version: null }),
		);
	});
});
