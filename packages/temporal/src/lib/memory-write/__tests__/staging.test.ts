/**
 * The bytes of a Living Memory write between the request and the commit
 * (ADR-022): which keys are a project's own staging keys, and how a staged
 * file is read back and checked against what the write named. The storage is
 * a map.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	objects: new Map<string, Buffer>(),
	downloads: [] as string[],
	uploads: [] as Array<{
		key: string;
		bytes: Buffer;
		bucket: string;
		contentType: string;
	}>,
	deleted: [] as string[][],
	errors: 0,
}));

vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({
		getFileMetadata: async (key: string) => {
			const data = h.objects.get(key);
			return data ? { size: data.length } : null;
		},
		downloadFile: async (key: string) => {
			h.downloads.push(key);
			const data = h.objects.get(key);
			if (!data) {
				throw new Error("missing");
			}
			return { data };
		},
		uploadFile: async (
			key: string,
			bytes: Buffer,
			options: { bucket: string; contentType: string },
		) => {
			h.uploads.push({ key, bytes, ...options });
			h.objects.set(key, bytes);
		},
		deleteObjects: async (keys: string[]) => {
			h.deleted.push(keys);
			return {
				deleted: keys.length - h.errors,
				errors: Array.from({ length: h.errors }, () => ({
					key: "k",
					message: "no",
				})),
			};
		},
	}),
}));
vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { skills: "skills" } } },
}));

import {
	deleteStagedBytes,
	isMemoryWriteStagingKeyOf,
	MAX_STAGED_FILE_BYTES,
	newMemoryWriteStagingKey,
	readStagedBytes,
	sha256Hex,
	stageInlineBytes,
} from "../staging";

const UUID = "123e4567-e89b-12d3-a456-426614174000";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

beforeEach(() => {
	h.objects.clear();
	h.downloads = [];
	h.uploads = [];
	h.deleted = [];
	h.errors = 0;
});

describe("the staging key", () => {
	it("is memory-writes/<projectId>/<uuid>, a new one each time", () => {
		const first = newMemoryWriteStagingKey("proj_1");
		const second = newMemoryWriteStagingKey("proj_1");

		expect(first).toMatch(/^memory-writes\/proj_1\/[0-9a-f-]{36}$/);
		expect(first).not.toBe(second);
		expect(isMemoryWriteStagingKeyOf("proj_1", first)).toBe(true);
	});

	it.each([
		["another project's key", `memory-writes/proj_2/${UUID}`],
		["a key with a suffix", `memory-writes/proj_1/${UUID}/x`],
		["a key that is not a uuid", "memory-writes/proj_1/not-a-uuid"],
		["a key with no id", "memory-writes/proj_1/"],
		[
			"an instruction staging key",
			`projects/proj_1/instructions/staging/s/${UUID}`,
		],
		["a traversal", `memory-writes/proj_1/../proj_2/${UUID}`],
		["the empty key", ""],
	])("is not %s", (_name, key) => {
		expect(isMemoryWriteStagingKeyOf("proj_1", key)).toBe(false);
	});
});

describe("readStagedBytes", () => {
	const key = `memory-writes/proj_1/${UUID}`;
	const bytes = Buffer.from("# Notes\n");

	it("returns the bytes of a file that is exactly the one named", async () => {
		h.objects.set(key, bytes);

		const read = await readStagedBytes({
			key,
			bytes: bytes.length,
			sha256: sha(bytes),
		});

		expect(read).toEqual({ ok: true, bytes });
	});

	it("says missing for an object that is not there, and downloads nothing", async () => {
		expect(
			await readStagedBytes({ key, bytes: 1, sha256: "0".repeat(64) }),
		).toEqual({ ok: false, reason: "missing" });
		expect(h.downloads).toEqual([]);
	});

	it("never reads an object larger than a file may be, though the write named its size", async () => {
		const big = Buffer.alloc(MAX_STAGED_FILE_BYTES + 1, "a");
		h.objects.set(key, big);

		expect(
			await readStagedBytes({ key, bytes: big.length, sha256: sha(big) }),
		).toEqual({ ok: false, reason: "too-large" });
		expect(h.downloads).toEqual([]);
	});

	it("says size for an object of another size than the write named, before downloading it", async () => {
		h.objects.set(key, bytes);

		expect(
			await readStagedBytes({
				key,
				bytes: bytes.length + 1,
				sha256: sha(bytes),
			}),
		).toEqual({ ok: false, reason: "size" });
		expect(h.downloads).toEqual([]);
	});

	it("says sha256 for the right size with other bytes", async () => {
		h.objects.set(key, Buffer.from("# Other\n"));

		expect(
			await readStagedBytes({
				key,
				bytes: bytes.length,
				sha256: sha(bytes),
			}),
		).toEqual({ ok: false, reason: "sha256" });
	});
});

describe("stageInlineBytes", () => {
	it("stores text under a key of the project's own and describes what it stored", async () => {
		const bytes = Buffer.from("inline text\n");

		const staged = await stageInlineBytes({ projectId: "proj_1", bytes });

		expect(isMemoryWriteStagingKeyOf("proj_1", staged.stagedKey)).toBe(
			true,
		);
		expect(staged).toMatchObject({
			bytes: bytes.length,
			sha256: sha256Hex(bytes),
		});
		expect(h.uploads).toEqual([
			{
				key: staged.stagedKey,
				bytes,
				bucket: "skills",
				contentType: "text/plain; charset=utf-8",
			},
		]);
	});
});

describe("deleteStagedBytes", () => {
	it("removes the keys and counts those it could not", async () => {
		h.errors = 1;

		expect(await deleteStagedBytes(["a", "b"])).toBe(1);
		expect(h.deleted).toEqual([["a", "b"]]);
	});

	it("asks storage for nothing when there is nothing to remove", async () => {
		expect(await deleteStagedBytes([])).toBe(0);
		expect(h.deleted).toEqual([]);
	});
});
