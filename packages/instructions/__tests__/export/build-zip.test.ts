import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	downloadFile: vi.fn(),
	uploadFile: vi.fn(),
	getSignedUrl: vi.fn(),
	getFileMetadata: vi.fn(),
	deleteObjects: vi.fn(),
	getInstructionSnapshot: vi.fn(),
	listInstructionFiles: vi.fn(),
	exportKey: vi.fn(),
	warn: vi.fn(),
	appendCalls: [] as Array<{ path: string; mode: number | undefined }>,
	sink: undefined as { end: () => void } | undefined,
}));

vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { skills: "skills" } } },
}));

vi.mock("../../src/storage-keys", () => ({
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
	listInstructionFiles: (...a: unknown[]) => m.listInstructionFiles(...a),
}));

vi.mock("@repo/logs", () => ({ logger: { warn: m.warn } }));

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

import {
	buildInstructionSnapshotZip,
	warmInstructionSnapshotExport,
} from "../../src/export";

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
		m.listInstructionFiles,
		m.exportKey,
		m.warn,
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
		// (a.md slowest, c.md instant): the downloads now run CONCURRENTLY,
		// so completion order here is c, b, a — and the archive entries must
		// still land in the order the files were given. That is what the
		// slot-indexed results array buys: appending as each download
		// resolved would reverse this tree, and a zip's entry order is part
		// of what the manifest and the CLI's ledger read back.
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

	/**
	 * The fix itself. A 448-file snapshot downloaded one file at a time took
	 * 59-90 seconds to zip, which is what made the first `fabric instructions
	 * sync` of a new version time out. Ordering (above) is preserved by the
	 * results array, so nothing in the append assertions can tell whether the
	 * downloads actually overlapped — this does, by counting how many are in
	 * flight at once.
	 */
	it("downloads concurrently, up to the pool size and no further", async () => {
		const files = Array.from({ length: 40 }, (_, i) => ({
			path: `f${i}.md`,
			storageKey: `key-${i}`,
			mode: null,
		}));
		let inFlight = 0;
		let peak = 0;
		const release: Array<() => void> = [];
		m.downloadFile.mockImplementation(
			(storageKey: string) =>
				new Promise((resolve) => {
					inFlight += 1;
					peak = Math.max(peak, inFlight);
					release.push(() => {
						inFlight -= 1;
						resolve({
							data: Buffer.from(storageKey),
							contentType: "text/plain",
							size: 1,
						});
					});
				}),
		);
		m.exportKey.mockReturnValue(
			"projects/proj_1/instructions/exports/s.zip",
		);
		m.uploadFile.mockResolvedValue(undefined);
		m.getSignedUrl.mockResolvedValue("https://storage.example.com/signed");

		const built = buildInstructionSnapshotZip({
			projectId: "proj_1",
			organizationId: "org_1",
			snapshot,
			files,
		});

		// Drain the deferred downloads, letting the pool refill between
		// rounds, until every file has been served. A macrotask per round is
		// what lets the worker loop advance past its own awaits.
		for (
			let guard = 0;
			guard < 200 &&
			(release.length > 0 || m.downloadFile.mock.calls.length < 40);
			guard++
		) {
			while (release.length > 0) {
				release.shift()?.();
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		await built;

		expect(m.downloadFile).toHaveBeenCalledTimes(40);
		// Overlapping at all is the whole point...
		expect(peak).toBeGreaterThan(1);
		// ...and the cap is real: 40 simultaneous connections per download
		// request is the failure mode an unbounded `Promise.all` would have.
		expect(peak).toBeLessThanOrEqual(16);
		// Still in input order, with 40 entries rather than 16.
		expect(m.appendCalls.map((c) => c.path)).toEqual(
			files.map((f) => f.path),
		);
	});

	/**
	 * The fix for the other half of C1's finding: a rejected worker used to
	 * end the pool with `Promise.all` while up to 15 OTHER workers kept
	 * claiming and downloading, untracked, because every caller here catches.
	 * Now a worker never rejects — it records the first error, flips
	 * `stopped`, and returns — so `Promise.all` waits for the in-flight
	 * window to settle and no worker claims an index past it.
	 */
	it("stops claiming new files after a download fails, rejects with that same error once the in-flight window settles, and never uploads", async () => {
		const files = Array.from({ length: 40 }, (_, i) => ({
			path: `f${i}.md`,
			storageKey: `key-${i}`,
			mode: null,
		}));
		const boom = new Error("download failed");
		let calls = 0;
		const resolvers: Array<() => void> = [];
		m.downloadFile.mockImplementation((storageKey: string) => {
			calls += 1;
			// The 3rd call fails; every other call is held open until the
			// test releases it, so the in-flight window stays observable.
			if (calls === 3) {
				return Promise.reject(boom);
			}
			return new Promise((resolve) => {
				resolvers.push(() =>
					resolve({
						data: Buffer.from(storageKey),
						contentType: "text/plain",
						size: 1,
					}),
				);
			});
		});
		m.exportKey.mockReturnValue(
			"projects/proj_1/instructions/exports/s.zip",
		);

		const built = buildInstructionSnapshotZip({
			projectId: "proj_1",
			organizationId: "org_1",
			snapshot,
			files,
		}).then(
			() => null,
			(e: unknown) => e,
		);

		// Let the rejection propagate through the pool and stop it before any
		// of the still-open downloads are released.
		await new Promise((resolve) => setTimeout(resolve, 0));
		for (const release of resolvers) {
			release();
		}

		const error = await built;

		expect(error).toBe(boom);
		// Exactly the initial pool window (16) was ever claimed: nothing
		// beyond key-15 was requested once the pool stopped.
		expect(m.downloadFile).toHaveBeenCalledTimes(16);
		expect(m.downloadFile.mock.calls.map((c) => c[0])).toEqual(
			files.slice(0, 16).map((f) => f.storageKey),
		);
		expect(m.uploadFile).not.toHaveBeenCalled();
	});

	it("treats a rejection with `undefined` as a failure too: rejects, never appends the empty slot, never uploads", async () => {
		const files = Array.from({ length: 4 }, (_, i) => ({
			path: `f${i}.md`,
			storageKey: `key-${i}`,
			mode: null,
		}));
		let calls = 0;
		m.downloadFile.mockImplementation((storageKey: string) => {
			calls += 1;
			if (calls === 3) {
				// A falsy rejection value must not read as "no error".
				return Promise.reject(undefined);
			}
			return Promise.resolve({
				data: Buffer.from(storageKey),
				contentType: "text/plain",
				size: 1,
			});
		});
		m.exportKey.mockReturnValue(
			"projects/proj_1/instructions/exports/s.zip",
		);

		let settled: "resolved" | "rejected" | null = null;
		await buildInstructionSnapshotZip({
			projectId: "proj_1",
			organizationId: "org_1",
			snapshot,
			files,
		}).then(
			() => {
				settled = "resolved";
			},
			() => {
				settled = "rejected";
			},
		);

		expect(settled).toBe("rejected");
		expect(m.appendCalls).toHaveLength(0);
		expect(m.uploadFile).not.toHaveBeenCalled();
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

/**
 * Publishing a snapshot pre-builds its archive so the first person to run
 * `fabric instructions sync` on a new version does not pay for the build
 * inside their own request. Everything here is about that call being SAFE to
 * make after the pointer has already moved.
 */
describe("warmInstructionSnapshotExport", () => {
	const ref = {
		projectId: "proj_1",
		organizationId: "org_1",
		snapshotId: "s",
	};

	it("builds and uploads the archive for a READY snapshot", async () => {
		m.getInstructionSnapshot.mockResolvedValue({
			...snapshot,
			status: "READY",
		});
		m.listInstructionFiles.mockResolvedValue([
			{ path: "CLAUDE.md", storageKey: "key-claude", mode: null },
		]);
		m.exportKey.mockReturnValue(
			"projects/proj_1/instructions/exports/s-d1g357.zip",
		);
		m.uploadFile.mockResolvedValue(undefined);
		m.getSignedUrl.mockResolvedValue("https://storage.example.com/signed");

		await warmInstructionSnapshotExport(ref);

		expect(m.getInstructionSnapshot).toHaveBeenCalledWith(
			"s",
			"proj_1",
			"org_1",
		);
		expect(m.listInstructionFiles).toHaveBeenCalledWith("s", "org_1");
		expect(m.uploadFile).toHaveBeenCalledWith(
			"projects/proj_1/instructions/exports/s-d1g357.zip",
			expect.any(Buffer),
			{ bucket: "skills", contentType: "application/zip" },
		);
		expect(m.warn).not.toHaveBeenCalled();
	});

	/**
	 * The fix for Fizzy's idempotent-republish finding: the helper used to
	 * load every file row before the BUILDER discovered the archive already
	 * existed. It now probes with the same key the builder would derive and
	 * returns without listing files at all.
	 */
	it("probes for an existing archive before listing files, and does nothing else when one is there", async () => {
		m.getInstructionSnapshot.mockResolvedValue({
			...snapshot,
			status: "READY",
		});
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

		await warmInstructionSnapshotExport(ref);

		expect(m.getFileMetadata).toHaveBeenCalledWith(
			"projects/proj_1/instructions/exports/s-d1g357.zip",
			{ bucket: "skills" },
		);
		expect(m.listInstructionFiles).not.toHaveBeenCalled();
		expect(m.downloadFile).not.toHaveBeenCalled();
		expect(m.uploadFile).not.toHaveBeenCalled();
	});

	it("does nothing at all when the snapshot is gone", async () => {
		m.getInstructionSnapshot.mockResolvedValue(null);

		await warmInstructionSnapshotExport(ref);

		expect(m.listInstructionFiles).not.toHaveBeenCalled();
		expect(m.downloadFile).not.toHaveBeenCalled();
		expect(m.uploadFile).not.toHaveBeenCalled();
	});

	it("does nothing at all when the snapshot is not READY", async () => {
		// Only a READY snapshot is downloadable, so there is nothing to
		// pre-build — and a VALIDATING row has no digest to key an archive on.
		m.getInstructionSnapshot.mockResolvedValue({
			...snapshot,
			digest: null,
			status: "VALIDATING",
		});

		await warmInstructionSnapshotExport(ref);

		expect(m.listInstructionFiles).not.toHaveBeenCalled();
		expect(m.downloadFile).not.toHaveBeenCalled();
		expect(m.uploadFile).not.toHaveBeenCalled();
	});

	/**
	 * The contract every caller leans on. The pointer has already moved when
	 * this runs: a publish that succeeded must not be reported as a failure,
	 * and in the Temporal activity a throw here would retry a publish that
	 * already happened.
	 */
	it("swallows a storage failure, logging ids and the error class only", async () => {
		m.getInstructionSnapshot.mockResolvedValue({
			...snapshot,
			status: "READY",
		});
		m.listInstructionFiles.mockResolvedValue([
			{ path: "secrets/CLAUDE.md", storageKey: "key-claude", mode: null },
		]);
		m.exportKey.mockReturnValue(
			"projects/proj_1/instructions/exports/s-d1g357.zip",
		);
		m.getFileMetadata.mockRejectedValue(
			new TypeError("s3://bucket/projects/proj_1/... unreachable"),
		);

		await expect(
			warmInstructionSnapshotExport(ref),
		).resolves.toBeUndefined();

		expect(m.warn).toHaveBeenCalledTimes(1);
		const [payload] = m.warn.mock.calls[0] as [Record<string, unknown>];
		expect(payload).toEqual({
			event: "project.instructions.export_warm_failed",
			snapshotId: "s",
			projectId: "proj_1",
			organizationId: "org_1",
			failure: "TypeError",
		});
		// Never the message: it can quote a storage key, and never a file
		// path, which is user data.
		expect(JSON.stringify(payload)).not.toContain("unreachable");
		expect(JSON.stringify(payload)).not.toContain("secrets/CLAUDE.md");
	});
});
