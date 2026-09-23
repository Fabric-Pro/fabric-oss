/**
 * Drives the REAL `uploadSnapshot` orchestration (`orpcClient` and `fetch`
 * mocked) — `UploadFolderDialog.test.tsx` mocks this whole module, so none
 * of this control flow was previously exercised by any test.
 */
import type { FolderEntry } from "../read-folder";

const { begin, listFiles, createUploadUrls, finalize } = vi.hoisted(() => ({
	begin: vi.fn(),
	listFiles: vi.fn(),
	createUploadUrls: vi.fn(),
	finalize: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			instructions: { begin, listFiles, createUploadUrls, finalize },
		},
	},
}));

import { uploadSnapshot } from "../upload-snapshot";

function entry(path: string, overrides?: Partial<FolderEntry>): FolderEntry {
	return {
		path,
		file: new File(["x"], path.split("/").pop() ?? path),
		size: 10,
		sha256: "a".repeat(64),
		kind: "OTHER",
		excluded: null,
		secretRule: null,
		...overrides,
	};
}

beforeEach(() => {
	begin.mockReset();
	listFiles.mockReset();
	createUploadUrls.mockReset();
	finalize.mockReset();
	finalize.mockResolvedValue({ status: "VALIDATING" });
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("uploadSnapshot", () => {
	it("calls begin -> listFiles(includeReceiving) -> createUploadUrls -> PUT -> finalize in that order, with the exact url/contentType", async () => {
		begin.mockResolvedValue({
			snapshotId: "snap_1",
			version: 1,
			keptCount: 1,
			excludedCount: 0,
			excluded: [],
		});
		listFiles.mockResolvedValue([{ id: "file_1", path: "CLAUDE.md" }]);
		createUploadUrls.mockResolvedValue({
			uploads: [
				{
					fileId: "file_1",
					path: "CLAUDE.md",
					url: "https://storage.example.com/put/file_1",
					contentType: "text/markdown",
				},
			],
		});
		const fetchMock = vi
			.fn()
			.mockResolvedValue({ ok: true, status: 200 } as Response);
		vi.stubGlobal("fetch", fetchMock);

		const e = entry("CLAUDE.md");
		const result = await uploadSnapshot({
			projectId: "proj_1",
			entries: [e],
			fabricIgnoreText: null,
			publishOnReady: true,
		});

		expect(result).toEqual({
			snapshotId: "snap_1",
			serverExcludedPaths: [],
		});
		expect(listFiles).toHaveBeenCalledWith({
			projectId: "proj_1",
			snapshotId: "snap_1",
			includeReceiving: true,
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"https://storage.example.com/put/file_1",
			{
				method: "PUT",
				body: e.file,
				headers: { "Content-Type": "text/markdown" },
			},
		);

		// Call order across all four mocked oRPC calls plus the PUT itself.
		const order = [
			begin.mock.invocationCallOrder[0],
			listFiles.mock.invocationCallOrder[0],
			createUploadUrls.mock.invocationCallOrder[0],
			fetchMock.mock.invocationCallOrder[0],
			finalize.mock.invocationCallOrder[0],
		];
		expect(order).toEqual([...order].sort((a, b) => a - b));
		expect(new Set(order).size).toBe(5); // every step ran exactly once, strictly in sequence
	});

	it("pages fileIds within the server's 200-item createUploadUrls limit", async () => {
		const TOTAL = 250;
		begin.mockResolvedValue({ snapshotId: "snap_1" });
		const files = Array.from({ length: TOTAL }, (_, i) => ({
			id: `file_${i}`,
			path: `file-${i}.md`,
		}));
		listFiles.mockResolvedValue(files);
		const pathById = new Map(files.map((f) => [f.id, f.path]));
		createUploadUrls.mockImplementation(
			async ({ fileIds }: { fileIds: string[] }) => ({
				uploads: fileIds.map((id) => ({
					fileId: id,
					path: pathById.get(id),
					url: `https://storage.example.com/put/${id}`,
					contentType: "text/plain",
				})),
			}),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response),
		);

		const entries = files.map((f) => entry(f.path));
		await uploadSnapshot({
			projectId: "proj_1",
			entries,
			fabricIgnoreText: null,
			publishOnReady: true,
		});

		expect(createUploadUrls).toHaveBeenCalledTimes(2);
		expect(createUploadUrls.mock.calls[0][0].fileIds).toHaveLength(200);
		expect(createUploadUrls.mock.calls[1][0].fileIds).toHaveLength(50);
	});

	it("never runs more than 6 PUTs concurrently", async () => {
		const COUNT = 12;
		begin.mockResolvedValue({ snapshotId: "snap_1" });
		const files = Array.from({ length: COUNT }, (_, i) => ({
			id: `file_${i}`,
			path: `file-${i}.md`,
		}));
		listFiles.mockResolvedValue(files);
		createUploadUrls.mockResolvedValue({
			uploads: files.map((f) => ({
				fileId: f.id,
				path: f.path,
				url: `https://storage.example.com/put/${f.id}`,
				contentType: "text/plain",
			})),
		});
		let inFlight = 0;
		let maxInFlight = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async () => {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((r) => setTimeout(r, 20));
				inFlight--;
				return { ok: true, status: 200 } as Response;
			}),
		);

		await uploadSnapshot({
			projectId: "proj_1",
			entries: files.map((f) => entry(f.path)),
			fabricIgnoreText: null,
			publishOnReady: true,
		});

		expect(maxInFlight).toBeLessThanOrEqual(6);
		// With 12 files and a cap of 6, the steady state should actually
		// reach the cap — a regression that silently lowers or removes the
		// bound would otherwise pass a "<=6" assertion by accident.
		expect(maxInFlight).toBe(6);
	});

	it("rejects with the file's path when a PUT exhausts its retries", async () => {
		vi.useFakeTimers();
		begin.mockResolvedValue({ snapshotId: "snap_1" });
		listFiles.mockResolvedValue([
			{ id: "file_1", path: "secrets/leaked.env" },
		]);
		createUploadUrls.mockResolvedValue({
			uploads: [
				{
					fileId: "file_1",
					path: "secrets/leaked.env",
					url: "https://storage.example.com/put/file_1",
					contentType: "text/plain",
				},
			],
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response),
		);

		const uploadPromise = uploadSnapshot({
			projectId: "proj_1",
			entries: [entry("secrets/leaked.env")],
			fabricIgnoreText: null,
			publishOnReady: true,
		});
		// Attach the rejection expectation BEFORE advancing timers: it
		// installs a rejection handler synchronously, so the retry loop's
		// eventual throw (driven by `runAllTimersAsync` below) is never
		// briefly unhandled.
		const assertion =
			expect(uploadPromise).rejects.toThrow(/secrets\/leaked\.env/);
		// Drives the 3-attempt exponential backoff (500ms/1000ms/2000ms)
		// without waiting on the wall clock.
		await vi.runAllTimersAsync();
		await assertion;
		expect(finalize).not.toHaveBeenCalled();
	});

	it("resuming a snapshot skips begin, re-lists the existing snapshot's files, and never re-hashes (uploadSnapshot has no hashing of its own — that lives in read-folder.ts)", async () => {
		listFiles.mockResolvedValue([{ id: "file_1", path: "CLAUDE.md" }]);
		createUploadUrls.mockResolvedValue({
			uploads: [
				{
					fileId: "file_1",
					path: "CLAUDE.md",
					url: "https://storage.example.com/put/file_1",
					contentType: "text/markdown",
				},
			],
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response),
		);
		const onSnapshotStarted = vi.fn();

		const e = entry("CLAUDE.md");
		const originalSha256 = e.sha256;
		const result = await uploadSnapshot({
			projectId: "proj_1",
			entries: [e],
			fabricIgnoreText: null,
			publishOnReady: true,
			resumeSnapshotId: "existing-snap",
			onSnapshotStarted,
		});

		expect(begin).not.toHaveBeenCalled();
		expect(listFiles).toHaveBeenCalledWith({
			projectId: "proj_1",
			snapshotId: "existing-snap",
			includeReceiving: true,
		});
		expect(result.snapshotId).toBe("existing-snap");
		expect(onSnapshotStarted).toHaveBeenCalledWith("existing-snap");
		// The entry's precomputed hash is untouched — nothing in this module
		// reads `e.file`'s bytes to recompute it.
		expect(e.sha256).toBe(originalSha256);
	});

	it("treats a client-kept path the server's live settings excluded as reported, not thrown", async () => {
		begin.mockResolvedValue({ snapshotId: "snap_1" });
		// The server only created a file row for CLAUDE.md — "extra.md" was
		// client-kept (stale/default `projectGlobs`) but excluded server-side
		// by the project's real settings, so it never gets a row at all.
		listFiles.mockResolvedValue([{ id: "file_1", path: "CLAUDE.md" }]);
		createUploadUrls.mockResolvedValue({
			uploads: [
				{
					fileId: "file_1",
					path: "CLAUDE.md",
					url: "https://storage.example.com/put/file_1",
					contentType: "text/markdown",
				},
			],
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response),
		);

		const result = await uploadSnapshot({
			projectId: "proj_1",
			entries: [entry("CLAUDE.md"), entry("extra.md")],
			fabricIgnoreText: null,
			publishOnReady: true,
		});

		expect(result.serverExcludedPaths).toEqual(["extra.md"]);
	});

	// The excluded half of a pick used to be sent too, so every
	// `node_modules/` file counted against the server's input cap and had to
	// be hashed. Now only the kept half is sent, and the rest is a count.
	it("sends begin only the kept entries, plus how many were left out", async () => {
		begin.mockResolvedValue({ snapshotId: "snap_1" });
		listFiles.mockResolvedValue([{ id: "file_1", path: "CLAUDE.md" }]);
		createUploadUrls.mockResolvedValue({
			uploads: [
				{
					fileId: "file_1",
					path: "CLAUDE.md",
					url: "https://storage.example.com/put/file_1",
					contentType: "text/markdown",
				},
			],
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response),
		);

		await uploadSnapshot({
			projectId: "proj_1",
			entries: [
				entry("CLAUDE.md"),
				entry("notes.log", {
					sha256: null,
					excluded: { rule: "*.log", layer: "fabricignore" },
				}),
				entry("node_modules/x/index.js", {
					sha256: null,
					excluded: { rule: "**/node_modules/**", layer: "default" },
				}),
			],
			fabricIgnoreText: "*.log\n",
			publishOnReady: true,
		});

		expect(begin).toHaveBeenCalledWith({
			projectId: "proj_1",
			publishOnReady: true,
			fabricIgnoreText: "*.log\n",
			files: [{ path: "CLAUDE.md", size: 10, sha256: "a".repeat(64) }],
			clientExcludedCount: 2,
		});
	});

	// The server only creates rows for paths it was sent, so a listed path
	// the client excluded is as foreign as one it never had.
	it("throws for a server-listed path the client excluded and therefore never sent", async () => {
		begin.mockResolvedValue({ snapshotId: "snap_1" });
		listFiles.mockResolvedValue([{ id: "file_2", path: "notes.log" }]);
		createUploadUrls.mockResolvedValue({
			uploads: [
				{
					fileId: "file_2",
					path: "notes.log",
					url: "https://storage.example.com/put/file_2",
					contentType: "text/plain",
				},
			],
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response),
		);

		await expect(
			uploadSnapshot({
				projectId: "proj_1",
				entries: [
					entry("CLAUDE.md"),
					entry("notes.log", {
						sha256: null,
						excluded: { rule: "*.log", layer: "fabricignore" },
					}),
				],
				fabricIgnoreText: null,
				publishOnReady: true,
			}),
		).rejects.toThrow(/notes\.log/);
	});

	it("refuses to begin when a kept entry has no hash", async () => {
		await expect(
			uploadSnapshot({
				projectId: "proj_1",
				entries: [entry("CLAUDE.md", { sha256: null })],
				fabricIgnoreText: null,
				publishOnReady: true,
			}),
		).rejects.toThrow(/CLAUDE\.md/);
		expect(begin).not.toHaveBeenCalled();
	});

	it("reports a client-kept entry the server's listFiles omits as excluded, without throwing, and still uploads the rest", async () => {
		begin.mockResolvedValue({ snapshotId: "snap_1" });
		// "extra.md" was client-kept, but the server's live settings excluded
		// it at `begin` time, so it never gets a file row — only CLAUDE.md
		// does.
		listFiles.mockResolvedValue([{ id: "file_1", path: "CLAUDE.md" }]);
		createUploadUrls.mockResolvedValue({
			uploads: [
				{
					fileId: "file_1",
					path: "CLAUDE.md",
					url: "https://storage.example.com/put/file_1",
					contentType: "text/markdown",
				},
			],
		});
		const fetchMock = vi
			.fn()
			.mockResolvedValue({ ok: true, status: 200 } as Response);
		vi.stubGlobal("fetch", fetchMock);

		const result = await uploadSnapshot({
			projectId: "proj_1",
			entries: [entry("CLAUDE.md"), entry("extra.md")],
			fabricIgnoreText: null,
			publishOnReady: true,
		});

		expect(result.serverExcludedPaths).toEqual(["extra.md"]);
		expect(finalize).toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://storage.example.com/put/file_1",
			expect.objectContaining({ method: "PUT" }),
		);
	});

	it("still throws for a path the client never had at all", async () => {
		begin.mockResolvedValue({ snapshotId: "snap_1" });
		listFiles.mockResolvedValue([{ id: "file_1", path: "CLAUDE.md" }]);
		// The server's signed-URL response names a path that isn't anywhere
		// in the client's original entry list — a genuine anomaly, not a
		// settings race.
		createUploadUrls.mockResolvedValue({
			uploads: [
				{
					fileId: "file_1",
					path: "not-mine.md",
					url: "https://storage.example.com/put/file_1",
					contentType: "text/markdown",
				},
			],
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response),
		);

		await expect(
			uploadSnapshot({
				projectId: "proj_1",
				entries: [entry("CLAUDE.md")],
				fabricIgnoreText: null,
				publishOnReady: true,
			}),
		).rejects.toThrow(/not-mine\.md/);
	});
});
