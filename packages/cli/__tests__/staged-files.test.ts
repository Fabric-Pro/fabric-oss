import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchFilesOptions } from "../src/lib/instructions/file-downloads.js";
import { stageFilesByUrl } from "../src/lib/instructions/staged-files.js";

const roots: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(
		roots
			.splice(0)
			.map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function optionsFor(count: number) {
	const root = await mkdtemp(path.join(tmpdir(), "fabric-stage-test-"));
	roots.push(root);
	vi.stubEnv("TEMP", root);
	vi.stubEnv("TMP", root);
	vi.stubEnv("TMPDIR", root);
	const bytes = Buffer.from("verified\n");
	const files = Array.from({ length: count }, (_, index) => ({
		path: `file-${index}.md`,
		size: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	}));
	const downloaded: string[] = [];
	const createFileDownloadUrls = vi.fn<
		FetchFilesOptions["client"]["instructions"]["createFileDownloadUrls"]
	>(async (_project, request) => {
		if (createFileDownloadUrls.mock.calls.length > 1) {
			expect(downloaded).toHaveLength(200);
		}
		return {
			snapshotId: "snapshot-1",
			digest: request.digest,
			expiresInSeconds: 600,
			files: request.paths.map((filePath) => ({
				path: filePath,
				size: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				mode: 0o100644,
				url: `https://example.com/${filePath}`,
			})),
		};
	});
	const fetchImpl: typeof fetch = vi.fn(async (url) => {
		downloaded.push(String(url));
		return new Response(bytes);
	});
	const options: FetchFilesOptions = {
		client: { instructions: { createFileDownloadUrls } },
		projectId: "project-1",
		digest: "a".repeat(64),
		files,
		timeoutMs: 1000,
		fetchImpl,
	};
	return { options, root, bytes, createFileDownloadUrls, downloaded };
}

describe("verified temporary downloads", () => {
	it("finishes one URL batch before signing the next and cleans up after use", async () => {
		const fixture = await optionsFor(201);
		const staged = await stageFilesByUrl(fixture.options);
		expect(fixture.createFileDownloadUrls).toHaveBeenCalledTimes(2);
		expect(await staged.get("file-200.md")).toEqual(fixture.bytes);
		await staged.dispose();
		expect(await readdir(fixture.root)).toEqual([]);
	});

	it("removes every staged file if a later download is corrupt", async () => {
		const fixture = await optionsFor(201);
		fixture.options.fetchImpl = vi.fn(async (url) => {
			fixture.downloaded.push(String(url));
			return new Response(
				String(url).endsWith("file-200.md")
					? Buffer.from("tampered\n")
					: fixture.bytes,
			);
		});
		await expect(stageFilesByUrl(fixture.options)).rejects.toThrow(
			"does not match the manifest",
		);
		expect(await readdir(fixture.root)).toEqual([]);
	});

	it("rechecks staged bytes before they can be applied", async () => {
		const fixture = await optionsFor(1);
		const staged = await stageFilesByUrl(fixture.options);
		const [directory] = await readdir(fixture.root);
		await writeFile(path.join(fixture.root, directory, "0"), "tampered\n");
		await expect(staged.get("file-0.md")).rejects.toThrow(
			"does not match the manifest",
		);
		await staged.dispose();
	});
});
