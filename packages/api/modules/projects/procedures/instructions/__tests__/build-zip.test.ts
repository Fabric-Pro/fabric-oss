import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	downloadFile: vi.fn(),
	uploadFile: vi.fn(),
	getSignedUrl: vi.fn(),
	getFileMetadata: vi.fn(),
	deleteObjects: vi.fn(),
	getInstructionSnapshot: vi.fn(),
	exportKey: vi.fn(),
	appendCalls: [] as Array<{ path: string; mode: number | undefined }>,
	sink: undefined as { end: () => void } | undefined,
}));

vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { skills: "skills" } } },
}));

vi.mock("@repo/instructions", () => ({
	exportKey: (...a: unknown[]) => m.exportKey(...a),
}));

vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({
		downloadFile: m.downloadFile,
		uploadFile: m.uploadFile,
		getSignedUrl: m.getSignedUrl,
		getFileMetadata: m.getFileMetadata,
		deleteObjects: m.deleteObjects,
	}),
}));

vi.mock("@repo/database", () => ({
	getInstructionSnapshot: (...a: unknown[]) => m.getInstructionSnapshot(...a),
}));

// A stand-in for the real zip stream: `build-zip.ts` only ever calls
// `append`, `pipe`, `on`, and `finalize`. Recording `append`'s arguments is
// enough to assert entry path, mode, and order without parsing real zip
// bytes; `finalize` ends the real `PassThrough` sink so the module's own
// `done` promise (which waits for the sink's "end" event) resolves.
vi.mock("archiver", () => ({
	default: () => ({
		append: (_data: Buffer, options: { name: string; mode?: number }) => {
			m.appendCalls.push({ path: options.name, mode: options.mode });
		},
		pipe: (dest: { end: () => void }) => {
			m.sink = dest;
		},
		on: () => {},
		finalize: async () => {
			m.sink?.end();
		},
	}),
}));

import { buildInstructionSnapshotZip } from "../build-zip";

const snapshot = {
	id: "s",
	version: 3,
	digest: "d1g357",
	readyAt: new Date("2026-01-01T00:00:00Z"),
	createdAt: new Date("2025-12-01T00:00:00Z"),
};

beforeEach(() => {
	for (const fn of [
		m.downloadFile,
		m.uploadFile,
		m.getSignedUrl,
		m.getFileMetadata,
		m.deleteObjects,
		m.getInstructionSnapshot,
		m.exportKey,
	]) {
		fn.mockReset();
	}
	// Default: nothing built yet, so every existing case exercises the build
	// path rather than the reuse path added in R32.
	m.getFileMetadata.mockResolvedValue(null);
	// Default: the snapshot is still there when the archive finishes.
	m.getInstructionSnapshot.mockResolvedValue({ id: "s" });
	m.deleteObjects.mockResolvedValue({ deleted: 1, errors: [] });
	m.appendCalls = [];
	m.sink = undefined;
	m.downloadFile.mockResolvedValue({
		data: Buffer.from("x"),
		contentType: "text/plain",
		size: 1,
	});
});

describe("buildInstructionSnapshotZip", () => {
	it("adds each entry under its stored path, keeps the stored mode, and preserves input order even when downloads resolve out of order", async () => {
		// Synthetic paths only. Deliberately reversed resolution timing
		// (a.md slowest, c.md instant): the handler awaits each
		// `storage.downloadFile` sequentially inside a `for...of` loop, so the
		// archive entries must still land in the order the files were given,
		// never in download-completion order. A rewrite to something
		// concurrent (e.g. `Promise.all`) would append in c, b, a order here
		// and fail this assertion.
		const delays: Record<string, number> = {
			"key-a": 30,
			"key-b": 15,
			"key-c": 0,
		};
		m.downloadFile.mockImplementation(
			(storageKey: string) =>
				new Promise((resolve) => {
					setTimeout(
						() =>
							resolve({
								data: Buffer.from(storageKey),
								contentType: "text/plain",
								size: 1,
							}),
						delays[storageKey] ?? 0,
					);
				}),
		);
		m.exportKey.mockReturnValue(
			"projects/proj_1/instructions/exports/s.zip",
		);
		m.uploadFile.mockResolvedValue(undefined);
		m.getSignedUrl.mockResolvedValue("https://storage.example.com/signed");

		await buildInstructionSnapshotZip({
			projectId: "proj_1",
			organizationId: "org_1",
			snapshot,
			files: [
				{ path: "a.md", storageKey: "key-a", mode: null },
				{ path: "b.md", storageKey: "key-b", mode: null },
				{ path: "scripts/deploy.sh", storageKey: "key-c", mode: 0o755 },
			],
		});

		expect(m.appendCalls).toEqual([
			{ path: "a.md", mode: undefined },
			{ path: "b.md", mode: undefined },
			{ path: "scripts/deploy.sh", mode: 0o755 },
		]);
	});

	it("derives the export key from exportKey and uses it for both the upload and the signed URL", async () => {
		m.exportKey.mockReturnValue(
			"projects/proj_1/instructions/exports/s-123.zip",
		);
		m.uploadFile.mockResolvedValue(undefined);
		m.getSignedUrl.mockResolvedValue("https://storage.example.com/signed");

		const result = await buildInstructionSnapshotZip({
			projectId: "proj_1",
			organizationId: "org_1",
			snapshot,
			files: [
				{ path: "CLAUDE.md", storageKey: "key-claude", mode: null },
			],
		});

		// R32: the stamp is the snapshot's DIGEST, not a wall clock. A
		// snapshot is immutable, so one object per snapshot is correct and a
		// rebuild overwrites it; `Date.now()` wrote a fresh full copy of the
		// tree on every download and every MCP bundle call, into a prefix
		// nothing swept.
		expect(m.exportKey).toHaveBeenCalledWith("proj_1", "s", "d1g357");
		expect(result).toEqual({
			url: "https://storage.example.com/signed",
			key: "projects/proj_1/instructions/exports/s-123.zip",
		});
		expect(m.uploadFile).toHaveBeenCalledWith(
			"projects/proj_1/instructions/exports/s-123.zip",
			expect.any(Buffer),
			{ bucket: "skills", contentType: "application/zip" },
		);
		expect(m.getSignedUrl).toHaveBeenCalledWith(
			"projects/proj_1/instructions/exports/s-123.zip",
			{
				bucket: "skills",
				expiresIn: 600,
				responseContentDisposition:
					'attachment; filename="coding-instructions-v3.zip"',
			},
		);
	});

	it("reuses an export that already exists: signs it without downloading, zipping or uploading again", async () => {
		m.exportKey.mockReturnValue(
			"projects/proj_1/instructions/exports/s-d1g357.zip",
		);
		m.getFileMetadata.mockResolvedValue({
			size: 1024,
			contentType: "application/zip",
			uploadedAt: new Date(),
			pathname: "projects/proj_1/instructions/exports/s-d1g357.zip",
			url: "https://storage.example.com/object",
		});
		m.getSignedUrl.mockResolvedValue("https://storage.example.com/signed");

		const result = await buildInstructionSnapshotZip({
			projectId: "proj_1",
			organizationId: "org_1",
			snapshot,
			files: [
				{ path: "CLAUDE.md", storageKey: "key-claude", mode: null },
			],
		});

		expect(result).toEqual({
			url: "https://storage.example.com/signed",
			key: "projects/proj_1/instructions/exports/s-d1g357.zip",
		});
		// The saving that matters: an agent polling the bundle tool at every
		// session start no longer re-downloads and re-zips the whole tree.
		expect(m.downloadFile).not.toHaveBeenCalled();
		expect(m.uploadFile).not.toHaveBeenCalled();
		expect(m.appendCalls).toEqual([]);
		// It still gets a fresh short-lived URL.
		expect(m.getSignedUrl).toHaveBeenCalledTimes(1);
	});

	it("falls back to a deterministic stamp when a snapshot has no digest", async () => {
		m.exportKey.mockReturnValue(
			"projects/proj_1/instructions/exports/s-v3.zip",
		);
		m.uploadFile.mockResolvedValue(undefined);
		m.getSignedUrl.mockResolvedValue("https://storage.example.com/signed");

		await buildInstructionSnapshotZip({
			projectId: "proj_1",
			organizationId: "org_1",
			snapshot: { ...snapshot, digest: null },
			files: [
				{ path: "CLAUDE.md", storageKey: "key-claude", mode: null },
			],
		});

		expect(m.exportKey).toHaveBeenCalledWith("proj_1", "s", "v3");
	});

	// I3: a delete sweeps this snapshot's export prefix, so an archive whose
	// upload lands AFTER that sweep resurrects a full copy of a version
	// somebody deleted precisely because of what it held.
	it("deletes the export it just wrote and 404s when the snapshot vanished mid-build", async () => {
		m.exportKey.mockReturnValue(
			"projects/proj_1/instructions/exports/s-d1g357.zip",
		);
		m.uploadFile.mockResolvedValue(undefined);
		m.getInstructionSnapshot.mockResolvedValue(null);

		const error = await buildInstructionSnapshotZip({
			projectId: "proj_1",
			organizationId: "org_1",
			snapshot,
			files: [
				{ path: "CLAUDE.md", storageKey: "key-claude", mode: null },
			],
		}).then(
			() => null,
			(e: { code: string }) => e,
		);

		expect(error?.code).toBe("NOT_FOUND");
		expect(m.getInstructionSnapshot).toHaveBeenCalledWith(
			"s",
			"proj_1",
			"org_1",
		);
		expect(m.deleteObjects).toHaveBeenCalledWith(
			["projects/proj_1/instructions/exports/s-d1g357.zip"],
			{ bucket: "skills" },
		);
		// No link is handed back for an archive that should not exist.
		expect(m.getSignedUrl).not.toHaveBeenCalled();
	});

	// I5 (round 2): `deleteObjects` never throws and reports per-key failures
	// in `errors`. This call site discarded that result, so the one case the
	// re-read exists for could fail to clean up and still report only
	// NOT_FOUND, leaving a full copy of a deleted version behind with nothing
	// saying so.
	it("reports the cleanup failure, not NOT_FOUND, when the export it wrote could not be deleted", async () => {
		m.exportKey.mockReturnValue(
			"projects/proj_1/instructions/exports/s-d1g357.zip",
		);
		m.uploadFile.mockResolvedValue(undefined);
		m.getInstructionSnapshot.mockResolvedValue(null);
		m.deleteObjects.mockResolvedValue({
			deleted: 0,
			errors: [
				{
					key: "projects/proj_1/instructions/exports/s-d1g357.zip",
					message: "AccessDenied",
				},
			],
		});

		const error = await buildInstructionSnapshotZip({
			projectId: "proj_1",
			organizationId: "org_1",
			snapshot,
			files: [
				{ path: "CLAUDE.md", storageKey: "key-claude", mode: null },
			],
		}).then(
			() => null,
			(e: { code: string; message: string }) => e,
		);

		expect(error?.code).toBe("INTERNAL_SERVER_ERROR");
		expect(error?.message).toContain("1 stored object(s)");
		// Count only: a key names a project, a snapshot and a file id, and this
		// string is returned to the client.
		expect(error?.message).not.toContain("proj_1");
		expect(error?.message).not.toContain("d1g357");
		expect(m.getSignedUrl).not.toHaveBeenCalled();
	});

	it("does not re-check the snapshot on the reuse path, which writes nothing", async () => {
		m.exportKey.mockReturnValue(
			"projects/proj_1/instructions/exports/s-d1g357.zip",
		);
		m.getFileMetadata.mockResolvedValue({
			size: 1024,
			contentType: "application/zip",
			uploadedAt: new Date(),
			pathname: "projects/proj_1/instructions/exports/s-d1g357.zip",
			url: "https://storage.example.com/object",
		});
		m.getSignedUrl.mockResolvedValue("https://storage.example.com/signed");

		await buildInstructionSnapshotZip({
			projectId: "proj_1",
			organizationId: "org_1",
			snapshot,
			files: [
				{ path: "CLAUDE.md", storageKey: "key-claude", mode: null },
			],
		});

		// An object that already existed is one a concurrent delete's own
		// prefix sweep collects; nothing new was written to resurrect.
		expect(m.getInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.deleteObjects).not.toHaveBeenCalled();
	});
});
