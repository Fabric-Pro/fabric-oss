/**
 * `fabric instructions sync` fetches only the files it writes.
 *
 * The archive route returns one zip of the whole published tree, so a sync
 * that rewrites a single file of a thousand used to download all thousand.
 * A plan with a few writes now asks for signed URLs for exactly those files
 * and verifies each one against the MANIFEST entry it planned from; a plan
 * with many writes still takes the archive, and a published version that moved
 * after the plan was made falls back to one fresh manifest and the archive.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FabricError } from "@fabricorg/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLock } from "../src/lib/instructions/lock.js";
import { PER_FILE_MAX_WRITES } from "../src/lib/instructions/file-downloads.js";
import { computeSnapshotDigest } from "../src/lib/instructions/manifest.js";
import {
	FILE_URL_BASE,
	makeTree,
	manifestEntry,
	resetInstructionsMocks,
	runCli,
	seedLock,
	sha256,
	snapshotFor,
	stubBundle,
} from "./helpers/instructions-commands.js";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		getPublished: vi.fn(),
		createDownloadUrl: vi.fn(),
		createFileDownloadUrls: vi.fn(),
		getApiKey: vi.fn<() => string | undefined>(),
		getConfigPath: vi.fn<() => string>(),
		getDefaultContext: vi.fn<() => unknown>(),
		withoutContext: vi.fn(),
		getClient: vi.fn(),
	},
}));

vi.mock("../src/lib/config.js", () => ({
	getApiKey: mocks.getApiKey,
	getOAuth: () => undefined,
	hasStoredApiKey: () => mocks.getApiKey() !== undefined,
	getConfigPath: mocks.getConfigPath,
	getBaseUrl: () => undefined,
	getDefaultContext: mocks.getDefaultContext,
	getOutputFormat: () => "table",
}));

vi.mock("../src/lib/client.js", () => {
	const client = {
		instructions: {
			getPublished: mocks.getPublished,
			createDownloadUrl: mocks.createDownloadUrl,
			createFileDownloadUrls: mocks.createFileDownloadUrls,
		},
		withoutContext: () => {
			mocks.withoutContext();
			return client;
		},
	};
	return {
		getClient: (overrides: unknown) => {
			mocks.getClient(overrides);
			return client;
		},
	};
});

beforeEach(() => {
	resetInstructionsMocks(mocks);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** A tree whose lock holds the published v7 files, so only some paths are written. */
async function seededTree(files: Record<string, string>) {
	const dest = await makeTree();
	for (const [name, body] of Object.entries(files)) {
		await writeFile(path.join(dest, name), body);
	}
	await seedLock(
		dest,
		"c".repeat(64),
		Object.fromEntries(
			Object.entries(files).map(([name, body]) => [
				name,
				{ sha256: sha256(body), mode: 0o100644 },
			]),
		),
	);
	return dest;
}

function publish(manifest: ReturnType<typeof manifestEntry>[], version = 8) {
	mocks.getPublished.mockResolvedValue({
		published: true,
		sourceOfTruth: "UPLOAD",
		snapshot: snapshotFor(manifest, version),
		unchanged: false,
		changes: null,
		manifest,
	});
}

const sync = (dest: string) =>
	runCli(["sync", "--project", "project-1", "--dest", dest]);

describe("a sync with one write", () => {
	it("downloads that one file and makes no archive request", async () => {
		const dest = await seededTree({
			"AGENTS.md": "same\n",
			"CLAUDE.md": "before\n",
			"RULES.md": "same too\n",
		});
		const manifest = [
			manifestEntry("AGENTS.md", "same\n"),
			manifestEntry("CLAUDE.md", "after\n"),
			manifestEntry("RULES.md", "same too\n"),
		];
		publish(manifest);
		stubBundle({ "CLAUDE.md": "after\n" });

		const result = await sync(dest);

		expect(result.code).toBe(0);
		expect(await readFile(path.join(dest, "CLAUDE.md"), "utf8")).toBe(
			"after\n",
		);
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
		expect(mocks.createFileDownloadUrls).toHaveBeenCalledTimes(1);
		expect(mocks.createFileDownloadUrls).toHaveBeenCalledWith(
			"project-1",
			{ digest: computeSnapshotDigest(manifest), paths: ["CLAUDE.md"] },
			{ org: undefined },
		);
		const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
		expect(urls).toEqual([`${FILE_URL_BASE}CLAUDE.md`]);
		expect((await readLock(dest))?.files["CLAUDE.md"]).toEqual({
			sha256: sha256("after\n"),
			mode: 0o100644,
		});
	});

	it("refuses bytes that do not match the manifest's hash and writes nothing", async () => {
		const dest = await seededTree({ "CLAUDE.md": "before\n" });
		publish([manifestEntry("CLAUDE.md", "after!\n")]);
		// Same length as the manifest's, different bytes: only the hash can tell.
		stubBundle({ "CLAUDE.md": "other!\n" });

		const result = await sync(dest);

		expect(result.code).not.toBe(0);
		expect(await readFile(path.join(dest, "CLAUDE.md"), "utf8")).toBe(
			"before\n",
		);
		expect((await readLock(dest))?.files["CLAUDE.md"]?.sha256).toBe(
			sha256("before\n"),
		);
	});

	it("refuses a file whose size is not the manifest's", async () => {
		const dest = await seededTree({ "CLAUDE.md": "before\n" });
		publish([manifestEntry("CLAUDE.md", "after\n")]);
		stubBundle({ "CLAUDE.md": "after, and then some\n" });

		const result = await sync(dest);

		expect(result.code).not.toBe(0);
		expect(await readFile(path.join(dest, "CLAUDE.md"), "utf8")).toBe(
			"before\n",
		);
	});

	it("refuses a URL response that names a file it was not asked for", async () => {
		const dest = await seededTree({ "CLAUDE.md": "before\n" });
		publish([manifestEntry("CLAUDE.md", "after\n")]);
		mocks.createFileDownloadUrls.mockResolvedValue({
			snapshotId: "snap-2",
			digest: computeSnapshotDigest([
				manifestEntry("CLAUDE.md", "after\n"),
			]),
			files: [
				{
					path: "SOMETHING-ELSE.md",
					sha256: "",
					size: 0,
					mode: null,
					url: `${FILE_URL_BASE}SOMETHING-ELSE.md`,
				},
			],
			expiresInSeconds: 600,
		});
		stubBundle({ "CLAUDE.md": "after\n" });

		const result = await sync(dest);

		expect(result.code).not.toBe(0);
		expect(await readFile(path.join(dest, "CLAUDE.md"), "utf8")).toBe(
			"before\n",
		);
	});
});

describe("a sync with many writes", () => {
	it(`takes the archive above ${PER_FILE_MAX_WRITES} writes`, async () => {
		const dest = await makeTree();
		const bodies = Object.fromEntries(
			Array.from({ length: PER_FILE_MAX_WRITES + 1 }, (_, i) => [
				`rule-${i}.md`,
				`# rule ${i}\n`,
			]),
		);
		const manifest = Object.entries(bodies).map(([name, body]) =>
			manifestEntry(name, body),
		);
		publish(manifest);
		mocks.createDownloadUrl.mockResolvedValue({
			snapshotId: "snap-2",
			digest: computeSnapshotDigest(manifest),
			url: "https://storage.example.com/exports/snap-2.zip",
			expiresInSeconds: 600,
		});
		stubBundle(bodies);

		const result = await sync(dest);

		expect(result.code).toBe(0);
		expect(mocks.createFileDownloadUrls).not.toHaveBeenCalled();
		expect(mocks.createDownloadUrl).toHaveBeenCalledTimes(1);
		// The archive keeps its own client: the bundle budget and NO retries,
		// because a timed-out retry of that POST does not wait for the build
		// already running on the server, it starts another one.
		expect(mocks.getClient.mock.calls.map(([options]) => options)).toEqual([
			{ project: "project-1", timeoutMs: 15_000 },
			{
				project: "project-1",
				timeoutMs: 60_000,
				retry: { maxRetries: 0 },
			},
		]);
		expect(await readFile(path.join(dest, "rule-100.md"), "utf8")).toBe(
			"# rule 100\n",
		);
	});

	it(`still fetches by name at exactly ${PER_FILE_MAX_WRITES} writes`, async () => {
		const dest = await makeTree();
		const bodies = Object.fromEntries(
			Array.from({ length: PER_FILE_MAX_WRITES }, (_, i) => [
				`rule-${i}.md`,
				`# rule ${i}\n`,
			]),
		);
		publish(
			Object.entries(bodies).map(([name, body]) =>
				manifestEntry(name, body),
			),
		);
		stubBundle(bodies);

		const result = await sync(dest);

		expect(result.code).toBe(0);
		expect(mocks.createDownloadUrl).not.toHaveBeenCalled();
		expect(mocks.createFileDownloadUrls).toHaveBeenCalledTimes(1);
		expect(
			mocks.createFileDownloadUrls.mock.calls[0]?.[1].paths,
		).toHaveLength(PER_FILE_MAX_WRITES);
	});
});

describe("a published version that moved after the plan", () => {
	it("re-reads the manifest once and takes the archive of what is published now", async () => {
		const dest = await seededTree({ "CLAUDE.md": "before\n" });
		const first = [manifestEntry("CLAUDE.md", "after\n")];
		const second = [manifestEntry("CLAUDE.md", "after again\n")];
		mocks.getPublished
			.mockResolvedValueOnce({
				published: true,
				sourceOfTruth: "UPLOAD",
				snapshot: snapshotFor(first, 8),
				unchanged: false,
				changes: null,
				manifest: first,
			})
			.mockResolvedValueOnce({
				published: true,
				sourceOfTruth: "UPLOAD",
				snapshot: snapshotFor(second, 9),
				manifest: second,
			});
		mocks.createFileDownloadUrls.mockRejectedValue(
			new FabricError(
				"The published version changed",
				409,
				"PUBLISHED_CHANGED",
			),
		);
		mocks.createDownloadUrl.mockResolvedValue({
			snapshotId: "snap-3",
			digest: computeSnapshotDigest(second),
			url: "https://storage.example.com/exports/snap-3.zip",
			expiresInSeconds: 600,
		});
		stubBundle({ "CLAUDE.md": "after again\n" });

		const result = await sync(dest);

		expect(result.code).toBe(0);
		expect(await readFile(path.join(dest, "CLAUDE.md"), "utf8")).toBe(
			"after again\n",
		);
		expect(mocks.getPublished).toHaveBeenCalledTimes(2);
		expect(mocks.createFileDownloadUrls).toHaveBeenCalledTimes(1);
		expect(mocks.createDownloadUrl).toHaveBeenCalledTimes(1);
		expect((await readLock(dest))?.snapshotVersion).toBe(9);
	});

	it("does not loop: a second failure is a failure", async () => {
		const dest = await seededTree({ "CLAUDE.md": "before\n" });
		const manifest = [manifestEntry("CLAUDE.md", "after\n")];
		publish(manifest);
		mocks.createFileDownloadUrls.mockRejectedValue(
			new FabricError("changed", 409, "PUBLISHED_CHANGED"),
		);
		mocks.createDownloadUrl.mockRejectedValue(new Error("unavailable"));

		const result = await sync(dest);

		expect(result.code).not.toBe(0);
		expect(mocks.createFileDownloadUrls).toHaveBeenCalledTimes(1);
		expect(await readFile(path.join(dest, "CLAUDE.md"), "utf8")).toBe(
			"before\n",
		);
	});
});
