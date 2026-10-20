import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createFabric,
	type DirectInstructionRepositoryFilesRead,
} from "@fabricorg/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitBlobOid } from "../src/lib/git-blob.js";
import { readInstructions } from "../src/lib/plugin/source.js";

const pin = { generation: 3, commitSha: "a".repeat(40) };
const encode = (text: string) => new TextEncoder().encode(text);
type PageTransform = (
	page: DirectInstructionRepositoryFilesRead,
) => DirectInstructionRepositoryFilesRead;
let cache: string;
beforeEach(async () => {
	cache = await mkdtemp(path.join(tmpdir(), "fabric-bulk-source-"));
});
afterEach(async () => {
	await rm(cache, { recursive: true, force: true });
});

function fixture(
	options: {
		count?: number;
		pageSize?: number;
		stalePublished?: boolean;
		mutate?: PageTransform;
		signal?: AbortSignal;
	} = {},
) {
	const entries = Array.from({ length: options.count ?? 3 }, (_, index) => ({
		path: `.claude/skills/example-${index}/SKILL.md`,
		text: `Example skill ${index}\n`,
	}));
	const batches: string[][] = [];
	const starts: number[] = [];
	let singleReads = 0;
	const client = createFabric({
		apiKey: "fab_test_key",
		baseUrl: "https://example.com",
		retry: { maxRetries: 0 },
		fetch: async (url, init) => {
			const endpoint = new URL(String(url)).pathname;
			if (endpoint.endsWith("/repository/files")) {
				return Response.json({
					data: {
						...pin,
						incomplete: false,
						refusal: null,
						files: entries.map((file) => ({
							path: file.path,
							blobId: gitBlobOid(encode(file.text)),
							mode: "100755",
							kind: "SKILL",
							size: encode(file.text).length,
						})),
					},
				});
			}
			if (endpoint.endsWith("/repository/files/read")) {
				const body = JSON.parse(String(init?.body));
				batches.push(body.paths);
				starts.push(body.startIndex);
				const end = Math.min(
					body.paths.length,
					body.startIndex + (options.pageSize ?? 200),
				);
				const result: DirectInstructionRepositoryFilesRead = {
					...pin,
					nextIndex: end === body.paths.length ? null : end,
					files: body.paths
						.slice(body.startIndex, end)
						.map((filePath: string) => {
							const text =
								entries.find((file) => file.path === filePath)
									?.text ?? "";
							return {
								path: filePath,
								read: {
									state: "found",
									text,
									size: encode(text).length,
									textLength: Array.from(text).length,
								},
							};
						}),
				};
				return Response.json({
					data: options.mutate?.(result) ?? result,
				});
			}
			singleReads++;
			throw new Error("Unexpected endpoint");
		},
	});
	const read = () =>
		readInstructions({
			client,
			projectId: "project-1",
			cacheDirectory: cache,
			timeoutMs: 60_000,
			signal: options.signal,
			published: {
				published: false,
				sourceOfTruth: "REPOSITORY",
				direct: {
					availability: "READY",
					readState: "DIRECT",
					...pin,
					generation: options.stalePublished ? 1 : pin.generation,
					currentCommitSha: options.stalePublished
						? "b".repeat(40)
						: pin.commitSha,
					ref: "main",
					rootPath: "",
					provider: "GITHUB",
					repository: {
						provider: "GITHUB",
						host: "example.com",
						path: "example/repo",
						cloneUrl: null,
					},
				},
			},
		});
	return { read, entries, batches, starts, singleReads: () => singleReads };
}

describe("plugin direct source batches", () => {
	it("keeps the actual listing identity when publication metadata is stale", async () => {
		const result = await fixture({ stalePublished: true }).read();
		expect(result.source).toEqual({ kind: "repository", ...pin });
		expect(result.pin).toBe(`repo:${pin.generation}:${pin.commitSha}`);
	});

	it("reads a cold 1648-file source in nine requests and a warm source without content requests", async () => {
		const setup = fixture({ count: 1648 });
		const cold = await setup.read();
		expect(cold.source).toEqual({ kind: "repository", ...pin });
		expect(cold.listed[0]).toMatchObject({
			path: setup.entries[0]?.path,
			kind: "SKILL",
			mode: "100755",
			blobId: gitBlobOid(encode(setup.entries[0]?.text ?? "")),
		});
		expect(cold.files).toHaveLength(1648);
		expect(cold.files[0]?.mode).toBe(0o755);
		expect(setup.batches).toHaveLength(9);
		expect(setup.batches.every((batch) => batch.length <= 200)).toBe(true);
		expect(setup.singleReads()).toBe(0);
		const warm = await setup.read();
		expect(warm.files).toHaveLength(1648);
		expect(setup.batches).toHaveLength(9);
	});

	it("resumes pages at file boundaries and only requests damaged cache misses", async () => {
		const setup = fixture({ pageSize: 2 });
		await setup.read();
		expect(setup.starts).toEqual([0, 2]);
		const first = setup.entries[0];
		if (!first) throw new Error("Missing fixture");
		await writeFile(
			path.join(cache, "blobs", `git-${gitBlobOid(encode(first.text))}`),
			"damaged",
		);
		await setup.read();
		expect(setup.batches.at(-1)).toEqual([first.path]);
	});

	it("accepts an entire inline file beyond the old per-file text page size", async () => {
		const setup = fixture({ count: 1 });
		const file = setup.entries[0];
		if (!file) throw new Error("Missing fixture");
		file.text = "é".repeat(100_000);
		const result = await setup.read();
		expect(result.files[0]?.bytes.byteLength).toBe(200_000);
		expect(gitBlobOid(result.files[0]?.bytes ?? new Uint8Array())).toBe(
			gitBlobOid(encode(file.text)),
		);
		expect(setup.batches).toHaveLength(1);
	});

	const invalidPages: Array<{ name: string; mutate: PageTransform }> = [
		{
			name: "wrong generation",
			mutate: (page) => ({ ...page, generation: 99 }),
		},
		{
			name: "wrong commit",
			mutate: (page) => ({ ...page, commitSha: "b".repeat(40) }),
		},
		{
			name: "missing path",
			mutate: (page) => ({ ...page, files: page.files.slice(1) }),
		},
		{
			name: "duplicate path",
			mutate: (page) => ({
				...page,
				files: page.files.map((file) => ({
					...file,
					path: page.files[0]?.path ?? "",
				})),
			}),
		},
		{
			name: "stationary continuation",
			mutate: (page) => ({ ...page, nextIndex: 0 }),
		},
		{
			name: "blob mismatch",
			mutate: (page) => ({
				...page,
				files: page.files.map((file) => ({
					...file,
					read: {
						state: "found",
						text: "wrong",
						size: 5,
						textLength: 5,
					},
				})),
			}),
		},
		{
			name: "size mismatch",
			mutate: (page) => ({
				...page,
				files: page.files.map((file) => ({
					...file,
					read:
						file.read.state === "found"
							? { ...file.read, size: -1 }
							: file.read,
				})),
			}),
		},
		{
			name: "absent listed file",
			mutate: (page) => ({
				...page,
				files: page.files.map((file) => ({
					...file,
					read: { state: "absent" },
				})),
			}),
		},
	];
	it.each(invalidPages)("fails closed on $name", async ({ mutate }) => {
		await expect(fixture({ mutate }).read()).rejects.toThrow();
	});

	it("preserves explicit binary and oversized skips", async () => {
		const setup = fixture({
			mutate: (page) => ({
				...page,
				files: page.files.map((file, i) => ({
					...file,
					read:
						i === 0
							? { state: "binary", size: 5 }
							: { state: "tooLarge" },
				})),
			}),
		});
		const result = await setup.read();
		expect(result.files).toEqual([]);
		expect(result.skipped).toHaveLength(3);
	});

	it("stops between continuation pages when cancelled", async () => {
		const controller = new AbortController();
		const reason = new Error("Stopped");
		const setup = fixture({
			pageSize: 1,
			signal: controller.signal,
			mutate: (page) => {
				controller.abort(reason);
				return page;
			},
		});
		await expect(setup.read()).rejects.toBe(reason);
		expect(setup.batches).toHaveLength(1);
	});

	it("refuses unsafe and colliding listing paths before cache or content reads", async () => {
		const unsafe = fixture({ count: 1 });
		const file = unsafe.entries[0];
		if (!file) throw new Error("Missing fixture");
		file.path = "../outside.md";
		await expect(unsafe.read()).rejects.toThrow(
			"unsafe or colliding paths",
		);
		expect(unsafe.batches).toHaveLength(0);
		const collision = fixture({ count: 2 });
		const [first, second] = collision.entries;
		if (!first || !second) throw new Error("Missing fixture");
		second.path = first.path.toUpperCase();
		await expect(collision.read()).rejects.toThrow(
			"unsafe or colliding paths",
		);
		expect(collision.batches).toHaveLength(0);
	});
});
