import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	listInstructionFiles: vi.fn(),
	failInstructionSnapshot: vi.fn(),
	markInstructionSnapshotReady: vi.fn(),
	markInstructionSnapshotRejected: vi.fn(),
	updateInstructionFileMetadata: vi.fn(),
	getInstructionSnapshotById: vi.fn(),
	publishInstructionSnapshot: vi.fn(),
	listPrunableInstructionSnapshots: vi.fn(),
	deleteInstructionSnapshot: vi.fn(),
	recordAudit: vi.fn(),
	downloadFile: vi.fn(),
	copyFile: vi.fn(),
	uploadFile: vi.fn(),
	deleteObjects: vi.fn(),
	listObjects: vi.fn(),
	getFileMetadata: vi.fn(),
}));
vi.mock("@repo/database", () => ({ ...m }));
vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({
		downloadFile: m.downloadFile,
		copyFile: m.copyFile,
		uploadFile: m.uploadFile,
		deleteObjects: m.deleteObjects,
		listObjects: m.listObjects,
		getFileMetadata: m.getFileMetadata,
	}),
}));
vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { skills: "skills" } } },
}));

// Separate hoisted holder for the `@temporalio/activity` mock so the
// heartbeat spy (Important 3) can be asserted on from test bodies, without
// mixing it into `m` (which mirrors `@repo/database`/`@repo/storage` only).
const activityMocks = vi.hoisted(() => ({ heartbeat: vi.fn() }));
// R16 relies on `ApplicationFailure.nonRetryable` to signal a tenant
// mismatch as a non-retryable Temporal failure; the real class lives in
// `@temporalio/common` and is re-exported here, so the mock must carry a
// shape close enough to assert `nonRetryable: true` on the thrown value.
vi.mock("@temporalio/activity", () => ({
	heartbeat: activityMocks.heartbeat,
	ApplicationFailure: {
		nonRetryable: (message?: string | null, type?: string | null) => {
			const error = new Error(message ?? undefined) as Error & {
				nonRetryable: boolean;
				type?: string | null;
			};
			error.nonRetryable = true;
			error.type = type;
			return error;
		},
	},
}));

import { isStagingKey, snapshotKey, stagingKey } from "@repo/instructions";
import {
	finalizeInstructionSnapshot,
	markInstructionSnapshotFailed,
	pruneInstructionSnapshots,
	publishInstructionSnapshotActivity,
	rejectInstructionSnapshot,
	verifyAndScanInstructionFiles,
} from "../src/activities/project-instructions";

const snap = {
	snapshotId: "s",
	projectId: "p",
	organizationId: "o",
	userId: "u",
};
const sha = async (s: string | Buffer) => {
	const d = await crypto.subtle.digest(
		"SHA-256",
		typeof s === "string" ? new TextEncoder().encode(s) : new Uint8Array(s),
	);
	return Array.from(new Uint8Array(d), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
};

/**
 * Sets up the three things the combined gate reads for a snapshot: the file
 * rows, the staging listing, and the bytes each key's download returns.
 *
 * `sha256` and `size` default to the real digest and length of `data`, so a
 * case only names them when it wants the declared value to DISAGREE with the
 * bytes — which is the whole subject of C1.
 */
type StageSpec = {
	id: string;
	path: string;
	data?: Buffer;
	/** Declared hash. Defaults to the real digest of `data`. */
	sha256?: string;
	/** Declared size. Defaults to `data.length`. */
	size?: number;
	/** Size the staging listing reports. Defaults to the declared size. */
	listedSize?: number;
	/**
	 * Size a HEAD of the key reports. Defaults to the real byte length, so a
	 * case names it only when it wants the HEAD to disagree — either with the
	 * declared size (I1's pre-download refusal) or with the bytes the download
	 * then returns (an overwrite between the HEAD and the GET).
	 */
	headSize?: number;
	/** Present to a HEAD of the key at all. Default true. */
	headPresent?: boolean;
	/** Present in the staging listing at all. Default true. */
	listed?: boolean;
	isText?: boolean;
	/** Override the deterministic staging key (e.g. an already-promoted row). */
	storageKey?: string;
	mimeType?: string;
};

async function stage(specs: StageSpec[]) {
	const rows: Array<Record<string, unknown>> = [];
	const objects: Array<{ key: string; size: number; lastModified: Date }> =
		[];
	const bytes = new Map<string, Buffer>();
	const heads = new Map<string, number | null>();
	for (const spec of specs) {
		const data = spec.data ?? Buffer.alloc(0);
		const key = spec.storageKey ?? stagingKey("p", "s", spec.id);
		const size = spec.size ?? data.length;
		heads.set(
			key,
			spec.headPresent === false ? null : (spec.headSize ?? data.length),
		);
		rows.push({
			id: spec.id,
			path: spec.path,
			storageKey: key,
			size,
			sha256: spec.sha256 ?? (await sha(data)),
			isText: spec.isText ?? true,
			kind: "INSTRUCTIONS",
			name: null,
			description: null,
			mimeType: spec.mimeType ?? "text/markdown",
		});
		if (spec.listed !== false && isStagingKey(key)) {
			objects.push({
				key,
				size: spec.listedSize ?? size,
				lastModified: new Date(),
			});
		}
		bytes.set(key, data);
	}
	m.listInstructionFiles.mockResolvedValue(rows);
	m.listObjects.mockResolvedValue({ objects });
	m.getFileMetadata.mockImplementation(async (key: string) => {
		const size = heads.get(key);
		return size === undefined || size === null
			? null
			: {
					size,
					contentType: "t",
					uploadedAt: new Date(),
					pathname: key,
					url: `https://storage.example.com/${key}`,
				};
	});
	m.downloadFile.mockImplementation(async (key: string) => {
		const data = bytes.get(key);
		if (!data) {
			throw new Error(`unexpected download key: ${key}`);
		}
		return { data, contentType: "t", size: data.length };
	});
	return rows;
}

// R17: build the secret-shaped fixture from fragments at runtime rather than
// a literal AWS-style access key in source — the commit hook and the
// downstream OSS relay both run gitleaks with no test-path allowlist, and a
// contiguous "AKIA" + 16 chars literal would trip it even though this one is
// the well-known AWS documentation EXAMPLE key.
const AWS_EXAMPLE_ACCESS_KEY = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

beforeEach(() => {
	for (const fn of Object.values(m)) {
		fn.mockReset();
	}
	activityMocks.heartbeat.mockReset();
	m.listObjects.mockResolvedValue({ objects: [] });
	m.deleteObjects.mockResolvedValue({ deleted: 0, errors: [] });
	// Fail-closed default; `stage()` replaces it with per-key sizes.
	m.getFileMetadata.mockResolvedValue(null);
	m.deleteInstructionSnapshot.mockResolvedValue({ deleted: true });
	// Default: this attempt is the one that makes the terminal transition.
	// The round-3 idempotency tests override these with `{ changed: false }`
	// to stand in for a retry that arrives after the verdict already
	// committed.
	m.markInstructionSnapshotReady.mockResolvedValue({ changed: true });
	m.markInstructionSnapshotRejected.mockResolvedValue({ changed: true });
	m.failInstructionSnapshot.mockResolvedValue({ changed: true });
	// Default: the snapshot exists and belongs to `snap`'s project/org, so
	// every activity's R16 tenant check passes and the existing behavioral
	// tests below exercise their intended logic rather than the gate.
	m.getInstructionSnapshotById.mockResolvedValue({
		id: "s",
		projectId: "p",
		organizationId: "o",
		publishOnReady: true,
		version: 7,
		fileCount: 3,
	});
});

// ---------------------------------------------------------------------------
// C1 — integrity and secrets are ONE pass over ONE download per object.
//
// They used to be two activities, and the split was the hole: the client's
// signed PUT stays usable, so a caller could upload bytes matching the
// declared hash, let verify accept them, overwrite the object while the scan
// pass was working through later files, and have the replacement promoted
// into the immutable snapshot under a digest built from the declared hashes.
// ---------------------------------------------------------------------------
describe("verifyAndScanInstructionFiles", () => {
	it("passes when every object matches its registered size and hash", async () => {
		await stage([
			{ id: "f1", path: "CLAUDE.md", data: Buffer.from("hello") },
		]);

		expect(await verifyAndScanInstructionFiles(snap)).toEqual({
			ok: true,
			rejections: [],
		});
		// Important 3: heartbeats at least once per file under the shared
		// 60s heartbeatTimeout.
		expect(activityMocks.heartbeat).toHaveBeenCalled();
	});

	it("hashes and scans the SAME buffer, with exactly one download per file (C1)", async () => {
		await stage([
			{ id: "f1", path: "CLAUDE.md", data: Buffer.from("hello") },
			{ id: "f2", path: "AGENTS.md", data: Buffer.from("world") },
		]);

		expect(await verifyAndScanInstructionFiles(snap)).toEqual({
			ok: true,
			rejections: [],
		});
		// Two files, two downloads. A second read of the same mutable key is
		// exactly the window this activity exists to remove.
		expect(m.downloadFile).toHaveBeenCalledTimes(2);
	});

	it("rejects a hash mismatch (after a successful download) and a missing object (absent from the listing), naming the paths", async () => {
		await stage([
			{
				id: "f1",
				path: "CLAUDE.md",
				data: Buffer.from("hello"),
				sha256: "0".repeat(64),
			},
			{
				id: "f2",
				path: "a.md",
				data: Buffer.from("x"),
				sha256: "0".repeat(64),
				listed: false,
			},
		]);

		const r = await verifyAndScanInstructionFiles(snap);

		expect(r.ok).toBe(false);
		expect(r.rejections.map((x) => [x.path, x.reason])).toEqual([
			["CLAUDE.md", "hash_mismatch"],
			["a.md", "missing"],
		]);
		// f2 was never downloaded — its key was already known absent.
		expect(m.downloadFile).toHaveBeenCalledTimes(1);
	});

	it("does not scan a file whose bytes no longer match its declared hash (C1)", async () => {
		// The declared hash is of benign content; the bytes now at the key
		// carry a credential. The integrity check fires first, so the file is
		// refused on the hash and never reaches the rule set — and either way
		// the snapshot is rejected.
		await stage([
			{
				id: "f1",
				path: ".claude/settings.json",
				data: Buffer.from(`{"pat": "${AWS_EXAMPLE_ACCESS_KEY}"}`),
				sha256: await sha("the benign bytes the client declared"),
			},
		]);

		const r = await verifyAndScanInstructionFiles(snap);

		expect(r).toEqual({
			ok: false,
			rejections: [
				{ path: ".claude/settings.json", reason: "hash_mismatch" },
			],
		});
	});

	it("rejects a size mismatch reported by the listing, without downloading", async () => {
		await stage([
			{
				id: "f1",
				path: "CLAUDE.md",
				data: Buffer.from("hello"),
				listedSize: 9,
			},
		]);

		const r = await verifyAndScanInstructionFiles(snap);

		expect(r.ok).toBe(false);
		expect(r.rejections).toEqual([
			{ path: "CLAUDE.md", reason: "size_mismatch", detail: "9 != 5" },
		]);
		expect(m.downloadFile).not.toHaveBeenCalled();
	});

	// -----------------------------------------------------------------------
	// I1 (round 2) — the declared size was only ever compared against the
	// staging LISTING, a snapshot of the prefix taken once at the top of the
	// gate. A client could register a small size with the hash of a much larger
	// payload, upload the small object so the listing agreed, then overwrite it
	// before its turn in the download loop: the listing passed, the hash of the
	// downloaded buffer passed, and the per-file and 50 MB total limits were
	// bypassed. The signed PUT cannot carry the length (the S3 provider ignores
	// `contentLength`), so these server-side checks are the whole enforcement.
	// -----------------------------------------------------------------------
	it("refuses an object whose stored size does not match the declared size, WITHOUT downloading it (I1)", async () => {
		await stage([
			{
				id: "f1",
				path: "CLAUDE.md",
				data: Buffer.from("hello"),
				// The listing still reports the registered size, so the cheap
				// first pass agrees; the object itself has since grown.
				headSize: 50_000_000,
			},
		]);

		const r = await verifyAndScanInstructionFiles(snap);

		expect(r).toEqual({
			ok: false,
			rejections: [
				{
					path: "CLAUDE.md",
					reason: "size_mismatch",
					detail: "50000000 != 5",
				},
			],
		});
		// The point of the HEAD: the worker never buffers the oversized object.
		expect(m.downloadFile).not.toHaveBeenCalled();
	});

	it("rejects a downloaded buffer longer than the declared size even when the HEAD agreed (I1)", async () => {
		await stage([
			{
				id: "f1",
				path: "CLAUDE.md",
				// 5 bytes registered and reported by both the listing and the
				// HEAD; the GET returns what is actually there now.
				data: Buffer.from("hello world, and then some"),
				size: 5,
				listedSize: 5,
				headSize: 5,
			},
		]);

		const r = await verifyAndScanInstructionFiles(snap);

		expect(r).toEqual({
			ok: false,
			rejections: [
				{
					path: "CLAUDE.md",
					reason: "size_mismatch",
					detail: "26 != 5",
				},
			],
		});
		// Refused on length before the hash is even computed, and nothing is
		// classified from bytes that were never accepted.
		expect(m.updateInstructionFileMetadata).not.toHaveBeenCalled();
	});

	it("rejects as missing when a HEAD says the object is not there", async () => {
		await stage([
			{
				id: "f1",
				path: "CLAUDE.md",
				data: Buffer.from("hello"),
				headPresent: false,
			},
		]);

		const r = await verifyAndScanInstructionFiles(snap);

		expect(r).toEqual({
			ok: false,
			rejections: [{ path: "CLAUDE.md", reason: "missing" }],
		});
		expect(m.downloadFile).not.toHaveBeenCalled();
	});

	it("propagates a download error instead of rejecting", async () => {
		await stage([
			{ id: "f1", path: "CLAUDE.md", data: Buffer.from("hello") },
		]);
		m.downloadFile.mockRejectedValue(new Error("connection reset"));

		await expect(verifyAndScanInstructionFiles(snap)).rejects.toThrow(
			"connection reset",
		);
	});

	// A partial promotion re-run must not report an already-promoted row as
	// "missing" just because it has left the staging prefix.
	it("passes when one row is already at its snapshot key from a partial promotion re-run", async () => {
		await stage([
			{ id: "f1", path: "CLAUDE.md", data: Buffer.from("hello") },
			{
				id: "f2",
				path: "AGENTS.md",
				data: Buffer.from("bye"),
				storageKey: snapshotKey("p", "s", "f2"),
			},
		]);

		const r = await verifyAndScanInstructionFiles(snap);

		expect(r).toEqual({ ok: true, rejections: [] });
		expect(m.downloadFile).toHaveBeenCalledWith(
			stagingKey("p", "s", "f1"),
			{
				bucket: "skills",
			},
		);
		expect(m.downloadFile).toHaveBeenCalledWith(
			snapshotKey("p", "s", "f2"),
			{ bucket: "skills" },
		);
	});

	it("rejects a file at neither its staging key nor its snapshot key as missing", async () => {
		await stage([
			{
				id: "f1",
				path: "weird.md",
				data: Buffer.from("hello"),
				storageKey: "projects/p/instructions/exports/s/f1",
			},
		]);

		const r = await verifyAndScanInstructionFiles(snap);

		expect(r).toEqual({
			ok: false,
			rejections: [{ path: "weird.md", reason: "missing" }],
		});
		expect(m.downloadFile).not.toHaveBeenCalled();
	});

	it("reports the file, rule, and line for a secret hit", async () => {
		await stage([
			{
				id: "f1",
				path: ".claude/settings.json",
				data: Buffer.from(`{\n "pat": "${AWS_EXAMPLE_ACCESS_KEY}"\n}`),
			},
		]);

		const r = await verifyAndScanInstructionFiles(snap);

		expect(r.ok).toBe(false);
		expect(r.rejections).toEqual([
			{
				path: ".claude/settings.json",
				reason: "secret",
				detail: "aws-access-key",
				line: 2,
			},
		]);
	});

	// R28/C1. The scan used to filter on `f.isText`, a flag assigned from a
	// 27-entry extension allowlist in `begin-snapshot.ts` that calls `.env`,
	// `.pem` and `.npmrc` binary. Those files were therefore never scanned,
	// were promoted into the immutable prefix, and were served over MCP and
	// the download. Every case below fails if the filter is restored.
	describe("R28: scannability is decided by the bytes, never by isText", () => {
		it.each([
			[".env", "**/.env"],
			["apps/web/.env.production", "**/.env.*"],
			["certs/server.pem", "**/*.pem"],
			[".ssh/id_ed25519", "**/id_ed25519"],
		] as const)(
			"rejects %s on its name alone, without downloading it",
			async (path, pattern) => {
				await stage([
					{
						id: "f1",
						path,
						data: Buffer.from("0123456789"),
						// The flag the old filter read. Irrelevant now.
						isText: false,
					},
				]);

				const r = await verifyAndScanInstructionFiles(snap);

				expect(r.ok).toBe(false);
				expect(r.rejections).toEqual([
					{
						path,
						reason: "secret",
						detail: `filename:${pattern}`,
					},
				]);
				// The whole point of the name gate: the bytes are never
				// fetched, so a credential file costs nothing to refuse.
				expect(m.downloadFile).not.toHaveBeenCalled();
			},
		);

		it("scans an isText:false row whose bytes are text, and rejects the key inside it", async () => {
			await stage([
				{
					id: "f1",
					// Not name-matched: a plain config file the extension
					// allowlist happens to call binary.
					path: "config/credentials.conf",
					data: Buffer.from(
						`[default]\naws_access_key_id = ${AWS_EXAMPLE_ACCESS_KEY}\n`,
					),
					isText: false,
				},
			]);

			const r = await verifyAndScanInstructionFiles(snap);

			expect(r.ok).toBe(false);
			expect(r.rejections).toEqual([
				{
					path: "config/credentials.conf",
					reason: "secret",
					detail: "aws-access-key",
					line: 2,
				},
			]);
		});

		it("still scans a NUL-free file that strict UTF-8 refuses (one Latin-1 byte) instead of skipping it", async () => {
			const token = ["ghp_", "a".repeat(36)].join("");
			const body = Buffer.concat([
				Buffer.from("caf"),
				Buffer.from([0xe9]), // é as a lone Latin-1 byte: invalid UTF-8, no NUL
				Buffer.from(`\ntoken: ${token}\n`),
			]);
			await stage([{ id: "f1", path: "docs/notes.md", data: body }]);

			const r = await verifyAndScanInstructionFiles(snap);

			expect(r.ok).toBe(false);
			expect(r.rejections).toEqual([
				expect.objectContaining({
					path: "docs/notes.md",
					reason: "secret",
					line: 2,
				}),
			]);
		});

		it("passes a genuinely binary object (PNG header, NUL bytes, invalid UTF-8) instead of scanning replacement characters", async () => {
			await stage([
				{
					id: "f1",
					path: "docs/diagram.png",
					data: Buffer.from([
						0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
						0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
					]),
					// Deliberately the opposite of the truth, to prove the
					// decision comes from the bytes and not from this flag.
					isText: true,
				},
			]);

			const r = await verifyAndScanInstructionFiles(snap);

			expect(r).toEqual({ ok: true, rejections: [] });
		});
	});
});

// ---------------------------------------------------------------------------
// C1 (round 2) — classification is part of the gate, over the buffer the gate
// verified. It used to be its own activity that re-downloaded the same mutable
// staging key WITHOUT re-hashing it, so frontmatter swapped in after the gate
// could be persisted as a file's `name`/`description` — the two columns MCP
// and the API listings serve — and could then be swapped back so promotion
// passed and the snapshot published.
// ---------------------------------------------------------------------------
describe("classification inside the gate (C1)", () => {
	it("persists kind, name and description parsed from the SAME buffer it hashed and scanned", async () => {
		await stage([
			{
				id: "skill-1",
				path: ".claude/skills/foo/SKILL.md",
				data: Buffer.from(
					"---\nname: foo\ndescription: does foo things\n---\nbody",
				),
			},
			{
				id: "script-1",
				path: "scripts/build.sh",
				data: Buffer.from("#!/bin/sh\necho hi\n"),
			},
		]);

		expect(await verifyAndScanInstructionFiles(snap)).toEqual({
			ok: true,
			rejections: [],
		});

		// Still ONE download per file: classification reuses the gate's buffer
		// rather than adding a read of its own.
		expect(m.downloadFile).toHaveBeenCalledTimes(2);
		expect(m.updateInstructionFileMetadata).toHaveBeenCalledWith(
			"skill-1",
			"o",
			{ kind: "SKILL", name: "foo", description: "does foo things" },
		);
		// The shebang is the only mode signal a browser upload can carry, so
		// the script is recorded executable; the Markdown file keeps mode
		// unset (null in the row) rather than being forced to anything.
		expect(m.updateInstructionFileMetadata).toHaveBeenCalledWith(
			"script-1",
			"o",
			{ kind: "SCRIPT", name: null, description: null, mode: 0o755 },
		);
	});

	it("records 0755 only for text that starts with a shebang", async () => {
		await stage([
			{
				id: "plain-1",
				path: "scripts/notes.txt",
				data: Buffer.from("not a script\n"),
			},
			{
				id: "js-1",
				path: "scripts/run.js",
				data: Buffer.from("#!/usr/bin/env node\nconsole.log(1)\n"),
			},
		]);

		expect(await verifyAndScanInstructionFiles(snap)).toEqual({
			ok: true,
			rejections: [],
		});

		expect(m.updateInstructionFileMetadata).toHaveBeenCalledWith(
			"plain-1",
			"o",
			expect.not.objectContaining({ mode: expect.anything() }),
		);
		expect(m.updateInstructionFileMetadata).toHaveBeenCalledWith(
			"js-1",
			"o",
			expect.objectContaining({ mode: 0o755 }),
		);
	});

	// The brief's required case: a staged object whose bytes differ from the
	// declared hash at classification time must never have metadata persisted,
	// and the snapshot must be rejected.
	it("persists NO metadata for a staged object whose bytes no longer match the declared hash, and rejects the snapshot", async () => {
		await stage([
			{
				id: "skill-1",
				path: ".claude/skills/foo/SKILL.md",
				// What is at the key now: frontmatter carrying a credential,
				// swapped in after the client declared the benign bytes.
				data: Buffer.from(
					`---\nname: foo\ndescription: key ${AWS_EXAMPLE_ACCESS_KEY}\n---\nbody`,
				),
				sha256: await sha("the benign bytes the client declared"),
			},
		]);

		const r = await verifyAndScanInstructionFiles(snap);

		expect(r).toEqual({
			ok: false,
			rejections: [
				{
					path: ".claude/skills/foo/SKILL.md",
					reason: "hash_mismatch",
				},
			],
		});
		expect(m.updateInstructionFileMetadata).not.toHaveBeenCalled();
	});

	it("persists no metadata for a file the rule set rejects", async () => {
		await stage([
			{
				id: "skill-1",
				path: ".claude/skills/foo/SKILL.md",
				data: Buffer.from(
					`---\nname: foo\ndescription: ${AWS_EXAMPLE_ACCESS_KEY}\n---\nbody`,
				),
			},
		]);

		const r = await verifyAndScanInstructionFiles(snap);

		expect(r.ok).toBe(false);
		expect(m.updateInstructionFileMetadata).not.toHaveBeenCalled();
	});

	it("persists no metadata for a file rejected on its name alone, which is never downloaded", async () => {
		await stage([{ id: "f1", path: ".env", data: Buffer.from("A=1") }]);

		expect((await verifyAndScanInstructionFiles(snap)).ok).toBe(false);
		expect(m.downloadFile).not.toHaveBeenCalled();
		expect(m.updateInstructionFileMetadata).not.toHaveBeenCalled();
	});

	it("classifies a binary object on its path alone, with no frontmatter read", async () => {
		await stage([
			{
				id: "f1",
				path: "docs/diagram.png",
				data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]),
			},
		]);

		expect(await verifyAndScanInstructionFiles(snap)).toEqual({
			ok: true,
			rejections: [],
		});
		expect(m.updateInstructionFileMetadata).toHaveBeenCalledWith(
			"f1",
			"o",
			{
				kind: "OTHER",
				name: null,
				description: null,
			},
		);
	});
});

describe("finalizeInstructionSnapshot", () => {
	it("re-hashes each staged object and PUTS those bytes at the snapshot key, never a server-side copy (C1)", async () => {
		await stage([
			{
				id: "f1",
				path: "CLAUDE.md",
				data: Buffer.from("hello"),
				mimeType: "text/markdown",
			},
		]);

		expect(await finalizeInstructionSnapshot(snap)).toEqual({
			ok: true,
			rejections: [],
		});

		// The buffer that was hashed is the buffer that was written. A
		// `copyFile` would read the mutable staging key a second time, which
		// is the window C1 is about.
		expect(m.copyFile).not.toHaveBeenCalled();
		expect(m.downloadFile).toHaveBeenCalledWith(
			stagingKey("p", "s", "f1"),
			{ bucket: "skills" },
		);
		expect(m.uploadFile).toHaveBeenCalledWith(
			"projects/p/instructions/snapshots/s/f1",
			Buffer.from("hello"),
			{ bucket: "skills", contentType: "text/markdown" },
		);
		expect(m.updateInstructionFileMetadata).toHaveBeenCalledWith(
			"f1",
			"o",
			expect.objectContaining({
				storageKey: "projects/p/instructions/snapshots/s/f1",
			}),
		);
		expect(m.markInstructionSnapshotReady).toHaveBeenCalledWith({
			snapshotId: "s",
			projectId: "p",
			organizationId: "o",
			fileCount: 1,
			storedBytes: 5,
			digest: expect.stringMatching(/^[0-9a-f]{64}$/),
			readyAt: expect.any(Date),
		});
		// Deleted by the DETERMINISTIC staging key (built from projectId/
		// snapshotId/fileId), not from whatever the row's storageKey happens
		// to hold at the time — this is what makes a retry after the row was
		// already rewritten still clean up (Important 1).
		expect(m.deleteObjects).toHaveBeenCalledWith(
			["projects/p/instructions/staging/s/f1"],
			{ bucket: "skills" },
		);
	});

	// C1: the staged bytes are mutable for as long as the client's signed PUT
	// lives, so the gate's verdict is about a moment that has passed. This is
	// the swap the review described — benign bytes accepted by the gate,
	// replaced before promotion — and it must refuse the whole snapshot.
	it("rejects the whole snapshot when a staged object's bytes changed after the gate (C1)", async () => {
		await stage([
			{
				id: "f1",
				path: "CLAUDE.md",
				data: Buffer.from("hello"),
			},
			{
				id: "f2",
				path: "AGENTS.md",
				// What is at the key now is NOT what the client declared and
				// what the gate hashed.
				data: Buffer.from(`swapped in: ${AWS_EXAMPLE_ACCESS_KEY}`),
				sha256: await sha("the bytes the gate accepted"),
			},
		]);

		const r = await finalizeInstructionSnapshot(snap);

		expect(r).toEqual({
			ok: false,
			rejections: [{ path: "AGENTS.md", reason: "hash_mismatch" }],
		});
		// The mismatched file is never written to the immutable prefix, and
		// the snapshot never reaches READY — no digest, no readyAt, nothing
		// publishable.
		expect(m.uploadFile).not.toHaveBeenCalledWith(
			"projects/p/instructions/snapshots/s/f2",
			expect.anything(),
			expect.anything(),
		);
		expect(m.markInstructionSnapshotReady).not.toHaveBeenCalled();
		expect(m.updateInstructionFileMetadata).not.toHaveBeenCalledWith(
			"f2",
			"o",
			expect.anything(),
		);
	});

	// I1 (round 2): promotion is the step that buffers the object and writes it
	// into the immutable prefix, so it carries the same two length checks as
	// the gate — the key is still writable between the two passes.
	it("refuses to download an object whose stored size no longer matches the declared size (I1)", async () => {
		await stage([
			{
				id: "f1",
				path: "CLAUDE.md",
				data: Buffer.from("hello"),
				headSize: 50_000_000,
			},
		]);

		const r = await finalizeInstructionSnapshot(snap);

		expect(r).toEqual({
			ok: false,
			rejections: [
				{
					path: "CLAUDE.md",
					reason: "size_mismatch",
					detail: "50000000 != 5",
				},
			],
		});
		expect(m.downloadFile).not.toHaveBeenCalled();
		expect(m.uploadFile).not.toHaveBeenCalled();
		expect(m.markInstructionSnapshotReady).not.toHaveBeenCalled();
	});

	it("rejects a downloaded buffer longer than the declared size even when the HEAD agreed (I1)", async () => {
		await stage([
			{
				id: "f1",
				path: "CLAUDE.md",
				data: Buffer.from("hello world, and then some"),
				size: 5,
				listedSize: 5,
				headSize: 5,
			},
		]);

		const r = await finalizeInstructionSnapshot(snap);

		expect(r).toEqual({
			ok: false,
			rejections: [
				{
					path: "CLAUDE.md",
					reason: "size_mismatch",
					detail: "26 != 5",
				},
			],
		});
		// Never written to the immutable prefix, and the snapshot's
		// `storedBytes` accounting is never told a size the bytes contradict.
		expect(m.uploadFile).not.toHaveBeenCalled();
		expect(m.markInstructionSnapshotReady).not.toHaveBeenCalled();
	});

	it("names every mismatched path, not only the first", async () => {
		await stage([
			{
				id: "f1",
				path: "a.md",
				data: Buffer.from("one"),
				sha256: "0".repeat(64),
			},
			{
				id: "f2",
				path: "b.md",
				data: Buffer.from("two"),
				sha256: "0".repeat(64),
			},
		]);

		const r = await finalizeInstructionSnapshot(snap);

		expect(r.ok).toBe(false);
		expect(r.rejections.map((x) => x.path)).toEqual(["a.md", "b.md"]);
	});

	it("still deletes the deterministic staging key on a retry where every row is already at its snapshot key (Important 1)", async () => {
		// Simulates a retry that resumes after a prior attempt already
		// rewrote the row's storageKey to the snapshot prefix. The OLD
		// implementation only collected staging keys for files it promoted
		// THIS attempt, so this case found nothing to delete and leaked the
		// object forever.
		await stage([
			{
				id: "f1",
				path: "CLAUDE.md",
				data: Buffer.from("hello"),
				storageKey: snapshotKey("p", "s", "f1"),
			},
		]);

		expect(await finalizeInstructionSnapshot(snap)).toEqual({
			ok: true,
			rejections: [],
		});
		// Re-hashed from where it already lives; nothing is re-written.
		expect(m.downloadFile).toHaveBeenCalledWith(
			snapshotKey("p", "s", "f1"),
			{ bucket: "skills" },
		);
		expect(m.uploadFile).not.toHaveBeenCalled();
		expect(m.deleteObjects).toHaveBeenCalledWith(
			["projects/p/instructions/staging/s/f1"],
			{ bucket: "skills" },
		);
	});

	it("sweeps and deletes a leftover staging object the deterministic set didn't name (Important 1)", async () => {
		await stage([
			{ id: "f1", path: "CLAUDE.md", data: Buffer.from("hello") },
		]);
		// An orphan object under the staging prefix with no matching file
		// row (e.g. from a since-deleted row) — only the paginated sweep
		// finds it. Applied after `stage` so the gate-shaped listing is
		// replaced for the cleanup sweep as well.
		m.listObjects.mockResolvedValue({
			objects: [
				{
					key: "projects/p/instructions/staging/s/orphan",
					size: 3,
					lastModified: new Date(),
				},
			],
		});

		await finalizeInstructionSnapshot(snap);

		expect(m.deleteObjects).toHaveBeenCalledWith(
			["projects/p/instructions/staging/s/f1"],
			{ bucket: "skills" },
		);
		expect(m.deleteObjects).toHaveBeenCalledWith(
			["projects/p/instructions/staging/s/orphan"],
			{ bucket: "skills" },
		);
	});
});

describe("rejectInstructionSnapshot", () => {
	it("marks REJECTED with the list and deletes staging by deterministic key", async () => {
		m.listInstructionFiles.mockResolvedValue([
			{
				id: "f1",
				path: "a",
				storageKey: "projects/p/instructions/staging/s/f1",
				size: 1,
				sha256: "x",
				isText: true,
			},
		]);
		await rejectInstructionSnapshot({
			...snap,
			rejections: [
				{ path: "a", reason: "secret", detail: "jwt", line: 3 },
			],
		});
		expect(m.markInstructionSnapshotRejected).toHaveBeenCalledWith(
			expect.objectContaining({
				snapshotId: "s",
				projectId: "p",
				organizationId: "o",
				rejections: [
					{ path: "a", reason: "secret", detail: "jwt", line: 3 },
				],
			}),
		);
		expect(m.deleteObjects).toHaveBeenCalledWith(
			["projects/p/instructions/staging/s/f1"],
			{ bucket: "skills" },
		);
	});
});

describe("publishInstructionSnapshotActivity", () => {
	it("publishes when publishOnReady is set and the publish call succeeds", async () => {
		m.publishInstructionSnapshot.mockResolvedValue({
			published: true,
			changed: true,
		});
		const r = await publishInstructionSnapshotActivity(snap);
		expect(r).toEqual({ published: true });
		expect(m.publishInstructionSnapshot).toHaveBeenCalledWith({
			snapshotId: "s",
			projectId: "p",
			organizationId: "o",
		});
	});

	it("skips the publish call when the snapshot is manual (publishOnReady false)", async () => {
		m.getInstructionSnapshotById.mockResolvedValue({
			id: "s",
			projectId: "p",
			organizationId: "o",
			publishOnReady: false,
		});
		const r = await publishInstructionSnapshotActivity(snap);
		expect(r).toEqual({ published: false, reason: "manual" });
		expect(m.publishInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.recordAudit).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// R29/I1 — publishOnReady defaults to true, so the auto-publish path IS the
// ordinary publish, and neither it nor the rejection path wrote an audit row.
// `project.instructions.rejected` had no writer at all.
// ---------------------------------------------------------------------------
describe("R29: audit rows from the workflow activities", () => {
	it("records project.instructions.published once, for the call that actually moved the pointer", async () => {
		m.publishInstructionSnapshot.mockResolvedValue({
			published: true,
			changed: true,
		});

		await publishInstructionSnapshotActivity(snap);

		expect(m.recordAudit).toHaveBeenCalledTimes(1);
		expect(m.recordAudit).toHaveBeenCalledWith({
			action: "project.instructions.published",
			category: "project",
			actor: { type: "user", userId: "u" },
			organizationId: "o",
			projectId: "p",
			resource: {
				type: "project_instruction_snapshot",
				id: "s",
				name: "v7",
			},
			metadata: {
				version: 7,
				fileCount: 3,
				source: "auto_publish_on_ready",
			},
		});
	});

	it("records nothing for the idempotent republish a Temporal retry produces (published: true, changed: false)", async () => {
		m.publishInstructionSnapshot.mockResolvedValue({
			published: true,
			changed: false,
		});

		const r = await publishInstructionSnapshotActivity(snap);

		// Still reports success to the workflow — the pointer IS where it
		// should be — but a retry must not multiply the audit row.
		expect(r).toEqual({ published: true });
		expect(m.recordAudit).not.toHaveBeenCalled();
	});

	it("records project.instructions.rejected with reason counts and rule ids, and no paths or matched text", async () => {
		m.listInstructionFiles.mockResolvedValue([]);

		await rejectInstructionSnapshot({
			...snap,
			rejections: [
				{
					path: "clients/acme/.env",
					reason: "secret",
					detail: "filename:**/.env",
				},
				{
					path: "config/app.conf",
					reason: "secret",
					detail: "aws-access-key",
					line: 12,
				},
				{ path: "docs/a.md", reason: "hash_mismatch" },
			],
		});

		// The row is handed to the verdict transaction, which inserts it with
		// `recordAuditTx` only when its conditional write actually made the
		// REJECTED transition (round 3). The payload is built here, so this is
		// where its redaction guarantees are asserted.
		expect(m.markInstructionSnapshotRejected).toHaveBeenCalledTimes(1);
		const [call] = m.markInstructionSnapshotRejected.mock.calls[0] as [
			{
				audit: Record<string, unknown> & {
					metadata: Record<string, unknown>;
				};
			},
		];
		const row = call.audit;
		expect(row.action).toBe("project.instructions.rejected");
		expect(row.outcome).toBe("failure");
		expect(row.actor).toEqual({ type: "user", userId: "u" });
		expect(row.organizationId).toBe("o");
		expect(row.projectId).toBe("p");
		expect(row.metadata).toEqual({
			rejectionCount: 3,
			reasonCounts: { secret: 2, hash_mismatch: 1 },
			rules: ["aws-access-key", "filename:**/.env"],
		});
		// The rejection list itself stays in the `rejection` column. Nothing
		// a user named or wrote reaches the audit log.
		const serialized = JSON.stringify(row);
		expect(serialized).not.toContain("acme");
		expect(serialized).not.toContain("app.conf");
		expect(serialized).not.toContain("docs/a.md");
	});
});

describe("pruneInstructionSnapshots", () => {
	it("deletes storage objects and rows for every prunable snapshot", async () => {
		m.listPrunableInstructionSnapshots.mockResolvedValue([
			{
				id: "old-1",
				storageKeys: ["projects/p/instructions/snapshots/old-1/f1"],
			},
			{ id: "old-2", storageKeys: [] },
		]);
		const r = await pruneInstructionSnapshots(snap);
		expect(r).toEqual({ deleted: 2 });
		// I3: the ROWS go first, then the objects they name. The old order
		// deleted the objects and only then the rows, so a publish landing on
		// a candidate between its selection and its deletion left the project
		// pointing at a snapshot whose bytes were already gone.
		expect(
			m.deleteInstructionSnapshot.mock.invocationCallOrder[0]!,
		).toBeLessThan(m.deleteObjects.mock.invocationCallOrder[0]!);
		expect(m.deleteObjects).toHaveBeenCalledWith(
			["projects/p/instructions/snapshots/old-1/f1"],
			{ bucket: "skills" },
		);
		expect(m.deleteInstructionSnapshot).toHaveBeenCalledWith(
			"old-1",
			"p",
			"o",
		);
		expect(m.deleteInstructionSnapshot).toHaveBeenCalledWith(
			"old-2",
			"p",
			"o",
		);
		// Minor 8: the retention counts are named constants, not bare
		// literals, at the call site into the query layer. M1 split them:
		// the READY window is spec §6.3.6's rollback history, while a
		// REJECTED/FAILED row is a diagnostic kept on its own, shorter
		// window — counting both against one window let a run of bad
		// uploads evict every kept version.
		expect(m.listPrunableInstructionSnapshots).toHaveBeenCalledWith(
			"p",
			"o",
			{ ready: 5, rejected: 2 },
		);
	});

	// I3: `listPrunableInstructionSnapshots` already excludes the published
	// pointer, so this is the race, not the ordinary case — a publish landing
	// on a candidate after it was selected. The `onDelete: Restrict` foreign
	// key refuses the row delete, and the candidate is skipped with its
	// objects untouched rather than having its bytes deleted underneath the
	// project that now publishes it.
	it("skips a candidate the foreign key refuses, leaving its objects alone", async () => {
		m.listPrunableInstructionSnapshots.mockResolvedValue([
			{
				id: "now-published",
				storageKeys: [
					"projects/p/instructions/snapshots/now-published/f1",
				],
			},
			{
				id: "old-2",
				storageKeys: ["projects/p/instructions/snapshots/old-2/f1"],
			},
		]);
		m.deleteInstructionSnapshot.mockImplementation(async (id: string) =>
			id === "now-published"
				? { deleted: false, reason: "published" }
				: { deleted: true },
		);

		const r = await pruneInstructionSnapshots(snap);

		// Only the candidate that was actually removed is counted.
		expect(r).toEqual({ deleted: 1 });
		expect(m.deleteObjects).not.toHaveBeenCalledWith(
			["projects/p/instructions/snapshots/now-published/f1"],
			{ bucket: "skills" },
		);
		expect(m.deleteObjects).toHaveBeenCalledWith(
			["projects/p/instructions/snapshots/old-2/f1"],
			{ bucket: "skills" },
		);
		// Nor is the refused candidate's export prefix swept.
		expect(m.listObjects).not.toHaveBeenCalledWith(
			expect.objectContaining({
				prefix: "projects/p/instructions/exports/now-published-",
			}),
		);
	});

	// R32/I4: the export zips are not in `storageKeys` — nothing records
	// which ones were built — so a pruned snapshot used to leave a full copy
	// of its contents behind for every download that had ever been taken.
	it("also deletes each pruned snapshot's export zips, found by prefix", async () => {
		m.listPrunableInstructionSnapshots.mockResolvedValue([
			{ id: "old-1", storageKeys: [] },
		]);
		m.listObjects.mockResolvedValue({
			objects: [
				{
					key: "projects/p/instructions/exports/old-1-digest.zip",
					size: 10,
				},
			],
		});

		await pruneInstructionSnapshots(snap);

		expect(m.listObjects).toHaveBeenCalledWith({
			bucket: "skills",
			prefix: "projects/p/instructions/exports/old-1-",
			continuationToken: undefined,
		});
		expect(m.deleteObjects).toHaveBeenCalledWith(
			["projects/p/instructions/exports/old-1-digest.zip"],
			{ bucket: "skills" },
		);
	});
});

// ---------------------------------------------------------------------------
// Minor 5 — rejection lists are capped so a pathological upload cannot
// return (and persist) an unbounded array.
// ---------------------------------------------------------------------------
describe("rejection cap (Minor 5)", () => {
	it("caps the rejection list at 100 entries with a trailing truncation marker", async () => {
		const files = Array.from({ length: 101 }, (_, i) => ({
			id: `f${i}`,
			path: `missing-${i}.md`,
			storageKey: stagingKey("p", "s", `f${i}`),
			size: 1,
			sha256: "x",
			isText: true,
		}));
		m.listInstructionFiles.mockResolvedValue(files);
		// Every key is absent from the listing, so every file rejects "missing".
		m.listObjects.mockResolvedValue({ objects: [] });

		const r = await verifyAndScanInstructionFiles(snap);

		expect(r.ok).toBe(false);
		expect(r.rejections).toHaveLength(101);
		expect(
			r.rejections.slice(0, 100).every((x) => x.reason === "missing"),
		).toBe(true);
		// Minor C: a recognizable sentinel, not a blank path that would render
		// as an empty row in a UI listing one row per rejection.
		expect(r.rejections[100]).toEqual({
			path: "(truncated)",
			reason: "truncated",
			detail: "1 more",
		});
	});
});

// ---------------------------------------------------------------------------
// R30/I2 — the terminal-failure marker. Before it, nothing in the feature
// ever wrote FAILED: a workflow whose activity exhausted its three attempts
// left the row VALIDATING, which the tab re-polls every three seconds
// forever, for every viewer.
// ---------------------------------------------------------------------------
describe("markInstructionSnapshotFailed", () => {
	/**
	 * Important 2 (round 4). The status guard used to be a READ followed by an
	 * unconditional write, and Temporal delivers activities AT LEAST ONCE: a
	 * timed-out attempt keeps running while its retries fail, so this marker
	 * could read VALIDATING, watch the original attempt commit READY, and only
	 * then stamp FAILED over that verdict — over bytes already promoted to the
	 * immutable prefix, and possibly over the snapshot the project's published
	 * pointer names, which the read APIs then refuse to serve.
	 *
	 * The guard is now the WRITE's own predicate, so these tests drive the
	 * outcome through the query's row count rather than through a status read
	 * the activity no longer performs.
	 */
	it("makes the whole transition in one conditional write scoped to snapshot, project and organization", async () => {
		m.failInstructionSnapshot.mockResolvedValue({ changed: true });

		expect(
			await markInstructionSnapshotFailed({
				...snap,
				failure: "TypeError",
			}),
		).toEqual({ marked: true });
		expect(m.failInstructionSnapshot).toHaveBeenCalledWith({
			snapshotId: "s",
			projectId: "p",
			organizationId: "o",
		});
		// No read-then-write: nothing decides the transition outside that
		// statement any more.
		expect(m.getInstructionSnapshotById).not.toHaveBeenCalled();
	});

	it("reports marked: false when the row already holds a verdict", async () => {
		// READY in particular: a workflow can fail AFTER finalize wrote READY
		// (a publish or prune error) and that snapshot's bytes are in the
		// immutable prefix — possibly already the published pointer.
		// Overwriting it would destroy a good version to report a problem with
		// a later step. Same for a REJECTED verdict committed by a slow
		// attempt while this marker was in flight.
		m.failInstructionSnapshot.mockResolvedValue({ changed: false });

		expect(
			await markInstructionSnapshotFailed({
				...snap,
				failure: "TypeError",
			}),
		).toEqual({ marked: false });
	});

	it("never deletes staging, because FAILED is re-attemptable through finalize", async () => {
		await markInstructionSnapshotFailed({ ...snap, failure: "TypeError" });

		expect(m.deleteObjects).not.toHaveBeenCalled();
		expect(m.listObjects).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// I1 — `deleteObjects` never throws and reports per-key failures in `errors`
// (packages/storage/types.ts). Every call site here discarded that result, so
// a snapshot could go terminally REJECTED while the secret-bearing staging
// object it was rejected FOR was still in the bucket.
// ---------------------------------------------------------------------------
describe("storage delete failures are not success (I1)", () => {
	const failed = {
		deleted: 0,
		errors: [
			{
				key: "projects/p/instructions/staging/s/f1",
				message: "AccessDenied",
			},
		],
	};

	it("fails rejectInstructionSnapshot when the staging cleanup could not delete", async () => {
		await stage([{ id: "f1", path: "a", data: Buffer.from("x") }]);
		m.deleteObjects.mockResolvedValue(failed);

		await expect(
			rejectInstructionSnapshot({ ...snap, rejections: [] }),
		).rejects.toThrow(/1 object\(s\)/);
	});

	it("fails finalizeInstructionSnapshot when the staging cleanup could not delete", async () => {
		await stage([{ id: "f1", path: "a", data: Buffer.from("x") }]);
		m.deleteObjects.mockResolvedValue(failed);

		await expect(finalizeInstructionSnapshot(snap)).rejects.toThrow(
			/1 object\(s\)/,
		);
	});

	it("fails pruneInstructionSnapshots when a pruned snapshot's objects could not be deleted", async () => {
		m.listPrunableInstructionSnapshots.mockResolvedValue([
			{
				id: "old-1",
				storageKeys: ["projects/p/instructions/snapshots/old-1/f1"],
			},
		]);
		m.deleteObjects.mockResolvedValue(failed);

		await expect(pruneInstructionSnapshots(snap)).rejects.toThrow(
			/1 object\(s\)/,
		);
	});

	it("fails the export-prefix sweep rather than reporting a clean prune", async () => {
		m.listPrunableInstructionSnapshots.mockResolvedValue([
			{ id: "old-1", storageKeys: [] },
		]);
		m.listObjects.mockResolvedValue({
			objects: [
				{
					key: "projects/p/instructions/exports/old-1-digest.zip",
					size: 10,
					lastModified: new Date(),
				},
			],
		});
		m.deleteObjects.mockResolvedValue(failed);

		await expect(pruneInstructionSnapshots(snap)).rejects.toThrow(
			/1 object\(s\)/,
		);
	});

	// -----------------------------------------------------------------------
	// I2 (round 2) — a terminal verdict must mean the staging objects are
	// gone. Cleanup used to run AFTER the status write and the audit, so a
	// rejection whose delete kept failing emitted an audit row per attempt and
	// then left a terminal REJECTED row (which `markInstructionSnapshotFailed`
	// refuses to move) with the secret-bearing object still in the bucket and
	// no state the UI could retry from.
	// -----------------------------------------------------------------------
	describe("terminal state comes after cleanup (I2)", () => {
		const rejections = [
			{ path: "a", reason: "secret", detail: "jwt", line: 3 },
		];

		it("writes no REJECTED and no audit when the staging cleanup throws", async () => {
			await stage([{ id: "f1", path: "a", data: Buffer.from("x") }]);
			m.deleteObjects.mockResolvedValue(failed);

			await expect(
				rejectInstructionSnapshot({ ...snap, rejections }),
			).rejects.toThrow(/1 object\(s\)/);

			expect(m.markInstructionSnapshotRejected).not.toHaveBeenCalled();
			expect(m.recordAudit).not.toHaveBeenCalled();
		});

		it("emits the rejection audit exactly once when the first attempt's cleanup failed", async () => {
			await stage([{ id: "f1", path: "a", data: Buffer.from("x") }]);
			m.deleteObjects
				.mockResolvedValueOnce(failed)
				.mockResolvedValue({ deleted: 1, errors: [] });

			// Attempt 1: Temporal sees the throw and retries.
			await expect(
				rejectInstructionSnapshot({ ...snap, rejections }),
			).rejects.toThrow(/1 object\(s\)/);
			// Attempt 2: the delete succeeds, so the verdict commits.
			await rejectInstructionSnapshot({ ...snap, rejections });

			// The verdict and its audit row are one transactional unit now, so
			// "exactly one audit" is "exactly one call to the helper that
			// carries it" — the row itself is written inside that transaction
			// and only when the conditional transition matched, which
			// `instructions-queries.test.ts` asserts directly.
			expect(m.markInstructionSnapshotRejected).toHaveBeenCalledTimes(1);
			expect(m.markInstructionSnapshotRejected).toHaveBeenCalledWith({
				snapshotId: "s",
				projectId: "p",
				organizationId: "o",
				rejections,
				audit: expect.objectContaining({
					action: "project.instructions.rejected",
					organizationId: "o",
					projectId: "p",
				}),
			});
		});

		it("deletes the staging objects before writing REJECTED and before auditing", async () => {
			await stage([{ id: "f1", path: "a", data: Buffer.from("x") }]);

			await rejectInstructionSnapshot({ ...snap, rejections });

			// One assertion covers both orderings: the audit row is written
			// inside the same transaction as the verdict.
			expect(m.deleteObjects.mock.invocationCallOrder[0]).toBeLessThan(
				m.markInstructionSnapshotRejected.mock.invocationCallOrder[0] ??
					0,
			);
		});

		it("writes no READY when the staging cleanup throws after a successful promotion", async () => {
			await stage([{ id: "f1", path: "a", data: Buffer.from("x") }]);
			m.deleteObjects.mockResolvedValue(failed);

			await expect(finalizeInstructionSnapshot(snap)).rejects.toThrow(
				/1 object\(s\)/,
			);

			// The bytes ARE promoted — the upload and the row's key move both
			// ran — but the snapshot is not terminal, so the boundary catch can
			// mark it FAILED and "Try again" re-runs the whole workflow.
			expect(m.uploadFile).toHaveBeenCalled();
			expect(m.markInstructionSnapshotReady).not.toHaveBeenCalled();
		});

		it("deletes the staging objects before writing READY", async () => {
			await stage([{ id: "f1", path: "a", data: Buffer.from("x") }]);

			expect(await finalizeInstructionSnapshot(snap)).toEqual({
				ok: true,
				rejections: [],
			});

			expect(m.deleteObjects.mock.invocationCallOrder[0]).toBeLessThan(
				m.markInstructionSnapshotReady.mock.invocationCallOrder[0] ?? 0,
			);
		});

		it("is idempotent on a retry whose staging prefix is already empty", async () => {
			await stage([
				{
					id: "f1",
					path: "a",
					data: Buffer.from("x"),
					// A previous attempt already promoted the row and swept the
					// prefix; only the snapshot key is left.
					storageKey: snapshotKey("p", "s", "f1"),
				},
			]);
			m.listObjects.mockResolvedValue({ objects: [] });
			m.deleteObjects.mockResolvedValue({ deleted: 0, errors: [] });

			expect(await finalizeInstructionSnapshot(snap)).toEqual({
				ok: true,
				rejections: [],
			});
			expect(m.markInstructionSnapshotReady).toHaveBeenCalledWith(
				expect.objectContaining({ snapshotId: "s", fileCount: 1 }),
			);
		});
	});

	// -----------------------------------------------------------------------
	// Round 3 — the retry that arrives AFTER the terminal side effects
	// committed. Temporal delivers an activity at least once: a worker can
	// commit the verdict and then die before its completion is acknowledged,
	// and the whole activity runs again. The I2 tests above only cover a retry
	// after the cleanup failed, i.e. BEFORE anything terminal was written.
	//
	// Both transitions are conditional now, so the second attempt's write
	// matches no row (`changed: false`), which is what the mocks below stand
	// in for. `instructions-queries.test.ts` asserts the condition itself.
	// -----------------------------------------------------------------------
	describe("a retry after the verdict already committed (round 3)", () => {
		const rejections = [
			{ path: "a", reason: "secret", detail: "jwt", line: 3 },
		];

		it("writes nothing and emits no audit when the snapshot is already REJECTED", async () => {
			// The first attempt swept the prefix, so this one finds it empty.
			await stage([
				{
					id: "f1",
					path: "a",
					data: Buffer.from("x"),
					listed: false,
				},
			]);
			m.listObjects.mockResolvedValue({ objects: [] });
			m.markInstructionSnapshotRejected.mockResolvedValue({
				changed: false,
			});

			await expect(
				rejectInstructionSnapshot({ ...snap, rejections }),
			).resolves.toBeUndefined();

			// No second audit row: the helper is asked once, its conditional
			// write matches nothing, and the row it would have inserted is
			// inside that same transaction.
			expect(m.markInstructionSnapshotRejected).toHaveBeenCalledTimes(1);
			expect(m.recordAudit).not.toHaveBeenCalled();
			expect(m.failInstructionSnapshot).not.toHaveBeenCalled();
		});

		it("returns the same success and rewrites no terminal field when the snapshot is already READY", async () => {
			await stage([
				{
					id: "f1",
					path: "a",
					data: Buffer.from("x"),
					// The first attempt promoted the row and swept the prefix.
					storageKey: snapshotKey("p", "s", "f1"),
				},
			]);
			m.listObjects.mockResolvedValue({ objects: [] });
			m.markInstructionSnapshotReady.mockResolvedValue({
				changed: false,
			});

			// Same result as the attempt that actually made the transition —
			// the workflow's publish and prune steps are idempotent and run as
			// before.
			expect(await finalizeInstructionSnapshot(snap)).toEqual({
				ok: true,
				rejections: [],
			});
			// `readyAt` and the digest are untouched: the only write this
			// activity makes is the conditional one, and it matched no row.
			expect(m.markInstructionSnapshotReady).toHaveBeenCalledTimes(1);
			expect(m.failInstructionSnapshot).not.toHaveBeenCalled();
			expect(m.recordAudit).not.toHaveBeenCalled();
		});
	});

	it("never names a key in the thrown message — only the count", async () => {
		m.listPrunableInstructionSnapshots.mockResolvedValue([
			{
				id: "old-1",
				storageKeys: ["projects/p/instructions/snapshots/old-1/f1"],
			},
		]);
		m.deleteObjects.mockResolvedValue(failed);

		const error = await pruneInstructionSnapshots(snap).then(
			() => null,
			(e: Error) => e,
		);
		expect(error?.message).not.toContain("projects/p");
		expect(error?.message).not.toContain("f1");
	});
});

// ---------------------------------------------------------------------------
// R16 — every activity verifies snapshot tenancy before touching storage.
// ---------------------------------------------------------------------------
describe("tenant verification (R16)", () => {
	const mismatched = { ...snap, organizationId: "other-org" };

	const cases: Array<[string, () => Promise<unknown>]> = [
		[
			"verifyAndScanInstructionFiles",
			() => verifyAndScanInstructionFiles(mismatched),
		],
		[
			"finalizeInstructionSnapshot",
			() => finalizeInstructionSnapshot(mismatched),
		],
		[
			"rejectInstructionSnapshot",
			() => rejectInstructionSnapshot({ ...mismatched, rejections: [] }),
		],
		[
			"publishInstructionSnapshotActivity",
			() => publishInstructionSnapshotActivity(mismatched),
		],
		[
			"pruneInstructionSnapshots",
			() => pruneInstructionSnapshots(mismatched),
		],
	];

	it.each(cases)(
		"%s throws a non-retryable failure on a tenant mismatch, without touching storage",
		async (_name, run) => {
			// getInstructionSnapshotById (from the default beforeEach mock) still
			// reports organizationId "o"; the ref passed here claims "other-org".
			await expect(run()).rejects.toMatchObject({ nonRetryable: true });
			expect(m.listInstructionFiles).not.toHaveBeenCalled();
			expect(m.downloadFile).not.toHaveBeenCalled();
			expect(m.copyFile).not.toHaveBeenCalled();
			expect(m.uploadFile).not.toHaveBeenCalled();
			expect(m.deleteObjects).not.toHaveBeenCalled();
			expect(m.listObjects).not.toHaveBeenCalled();
			expect(m.updateInstructionFileMetadata).not.toHaveBeenCalled();
			expect(m.failInstructionSnapshot).not.toHaveBeenCalled();
			expect(m.markInstructionSnapshotReady).not.toHaveBeenCalled();
			expect(m.markInstructionSnapshotRejected).not.toHaveBeenCalled();
			expect(m.publishInstructionSnapshot).not.toHaveBeenCalled();
			expect(m.listPrunableInstructionSnapshots).not.toHaveBeenCalled();
			expect(m.deleteInstructionSnapshot).not.toHaveBeenCalled();
		},
	);

	it("also throws when the snapshot cannot be found at all", async () => {
		m.getInstructionSnapshotById.mockResolvedValue(null);
		await expect(verifyAndScanInstructionFiles(snap)).rejects.toMatchObject(
			{
				nonRetryable: true,
			},
		);
		expect(m.listInstructionFiles).not.toHaveBeenCalled();
	});
});
