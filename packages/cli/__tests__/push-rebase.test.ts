/**
 * `fabric instructions push --rebase`, end to end with the SDK client mocked
 * at the `getClient` boundary and the signed URLs served from a stubbed
 * global fetch.
 *
 * The lock names version 7 and version 8 is published. Pinned here: a clean
 * merge is sent against version 8 with the merged text written into the
 * checkout; a conflict writes markers, sends nothing and never touches the
 * lock; a resolved conflict is taken as the checkout holds it on the next
 * run; and `--rebase` changes nothing about what a lock edited by hand or a
 * local override can make a push send.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildInstructionsCommand } from "../src/commands/instructions/index.js";
import type { InstructionsLock } from "../src/lib/instructions/lock.js";

const OUTSIDE_CONFIG_PATH = path.join(tmpdir(), "fabricai", "config.json");
const BASE_URL = "https://storage.example.com/base/";
const PUBLISHED_URL = "https://storage.example.com/published/";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		submitChange: vi.fn(),
		publishChange: vi.fn(),
		getPublished: vi.fn(),
		getProposalPullRequest: vi.fn(),
		getOpenProposals: vi.fn(),
		createVersionFileDownloadUrls: vi.fn(),
		createFileDownloadUrls: vi.fn(),
		getApiKey: vi.fn<() => string | undefined>(),
		getConfigPath: vi.fn<() => string>(),
	},
}));

vi.mock("../src/lib/config.js", () => ({
	getApiKey: mocks.getApiKey,
	getConfigPath: mocks.getConfigPath,
	getBaseUrl: () => undefined,
	getDefaultContext: () => undefined,
	getOutputFormat: () => "table",
}));

vi.mock("../src/lib/client.js", () => {
	const client = {
		instructions: {
			getPublished: mocks.getPublished,
			createDownloadUrl: vi.fn(),
			submitChange: mocks.submitChange,
			publishChange: mocks.publishChange,
			getProposalPullRequest: mocks.getProposalPullRequest,
			getOpenProposals: mocks.getOpenProposals,
			createVersionFileDownloadUrls: mocks.createVersionFileDownloadUrls,
			createFileDownloadUrls: mocks.createFileDownloadUrls,
		},
		withoutContext: () => client,
	};
	return { getClient: () => client };
});

class ExitSignal extends Error {
	constructor(readonly code: number) {
		super(`exit ${code}`);
	}
}

async function runCli(
	argv: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	const outSpy = vi
		.spyOn(process.stdout, "write")
		.mockImplementation((chunk: unknown) => {
			stdout += String(chunk);
			return true;
		});
	const errSpy = vi
		.spyOn(process.stderr, "write")
		.mockImplementation((chunk: unknown) => {
			stderr += String(chunk);
			return true;
		});
	const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
		code?: number,
	) => {
		throw new ExitSignal(code ?? 0);
	}) as never);
	let code = 0;
	try {
		await new Command("fabric")
			.exitOverride()
			.option("--format <format>", "Output format", "table")
			.addCommand(buildInstructionsCommand())
			.parseAsync(["instructions", ...argv], { from: "user" });
	} catch (error) {
		if (error instanceof ExitSignal) {
			code = error.code;
		} else {
			throw error;
		}
	} finally {
		outSpy.mockRestore();
		errSpy.mockRestore();
		exitSpy.mockRestore();
	}
	return { code, stdout, stderr };
}

function sha256(text: string): string {
	return createHash("sha256").update(Buffer.from(text)).digest("hex");
}

function entry(filePath: string, contents: string) {
	return {
		path: filePath,
		sha256: sha256(contents),
		size: Buffer.byteLength(contents),
		mode: 33188,
		kind: "INSTRUCTIONS",
	};
}

/**
 * A checkout synced at version 7 (`base`) holding `local`, with version 8
 * (`published`) published since. `ledger` overrides what the lock records.
 */
async function staleCheckout(input: {
	base: Record<string, string>;
	local: Record<string, string>;
	published: Record<string, string>;
	ledger?: Record<string, string>;
}): Promise<string> {
	const dest = await mkdtemp(path.join(tmpdir(), "fabric-rebase-"));
	for (const [relative, contents] of Object.entries(input.local)) {
		const target = path.join(dest, relative);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, contents);
	}
	const lock: InstructionsLock = {
		version: 1,
		projectId: "proj-1",
		snapshotId: "snap-7",
		snapshotVersion: 7,
		digest: "7".repeat(64),
		syncedAt: "2026-09-17T10:00:00.000Z",
		files: Object.fromEntries(
			Object.entries(input.ledger ?? input.base).map(
				([key, contents]) => [
					key,
					{ sha256: sha256(contents), mode: 33188 },
				],
			),
		),
	};
	await mkdir(path.join(dest, ".fabric"), { recursive: true });
	await writeFile(
		path.join(dest, ".fabric", "instructions.lock"),
		`${JSON.stringify(lock, null, 2)}\n`,
	);

	mocks.getPublished.mockResolvedValue({
		published: true,
		sourceOfTruth: "UPLOAD",
		snapshot: {
			id: "snap-8",
			version: 8,
			digest: "8".repeat(64),
			fileCount: Object.keys(input.published).length,
			publishedAt: "2026-09-18T09:00:00.000Z",
		},
		manifest: Object.entries(input.published).map(([p, c]) => entry(p, c)),
	});
	mocks.createVersionFileDownloadUrls.mockImplementation(
		async (_project: string, snapshotId: string, paths: string[]) => ({
			snapshotId,
			version: 7,
			digest: "7".repeat(64),
			files: paths
				.filter((p) => Object.hasOwn(input.base, p))
				.map((p) => ({
					...entry(p, input.base[p] ?? ""),
					url: `${BASE_URL}${encodeURIComponent(p)}`,
				})),
			missing: paths.filter((p) => !Object.hasOwn(input.base, p)),
			expiresInSeconds: 600,
		}),
	);
	mocks.createFileDownloadUrls.mockImplementation(
		async (
			_project: string,
			request: { digest: string; paths: string[] },
		) => ({
			snapshotId: "snap-8",
			digest: request.digest,
			files: request.paths.map((p) => ({
				...entry(p, input.published[p] ?? ""),
				url: `${PUBLISHED_URL}${encodeURIComponent(p)}`,
			})),
			expiresInSeconds: 600,
		}),
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (request: string | URL | Request) => {
			const url = String(request);
			const [files, prefix] = url.startsWith(BASE_URL)
				? [input.base, BASE_URL]
				: [input.published, PUBLISHED_URL];
			const body = files[decodeURIComponent(url.slice(prefix.length))];
			return body === undefined
				? new Response("not found", { status: 404 })
				: new Response(Buffer.from(body), { status: 200 });
		}),
	);
	return dest;
}

function accepted() {
	return {
		snapshotId: "snap-9",
		version: 9,
		baseSnapshotId: "snap-8",
		baseVersion: 8,
		fileCount: 2,
		inheritedCount: 1,
		putCount: 1,
		deleteCount: 0,
		proposalStatus: "PENDING",
		mode: "proposal",
		status: "VALIDATING",
		published: false,
	};
}

const push = (dest: string, ...extra: string[]) =>
	runCli([
		"push",
		"--project",
		"proj-1",
		"--dest",
		dest,
		"--no-wait",
		...extra,
	]);

const lockOf = (dest: string) =>
	readFile(path.join(dest, ".fabric", "instructions.lock"), "utf8");

beforeEach(() => {
	for (const mock of Object.values(mocks)) {
		mock.mockReset();
	}
	mocks.getOpenProposals.mockResolvedValue([]);
	mocks.getApiKey.mockReturnValue("fab_test");
	mocks.getConfigPath.mockReturnValue(OUTSIDE_CONFIG_PATH);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("push --rebase", () => {
	it("still refuses a stale checkout without the flag, and names it", async () => {
		const dest = await staleCheckout({
			base: { "AGENTS.md": "a\n" },
			local: { "AGENTS.md": "mine\n" },
			published: { "AGENTS.md": "theirs\n" },
		});

		const result = await push(dest);

		expect(result.code).toBe(7);
		expect(result.stderr).toContain("instructions push --rebase");
		expect(mocks.submitChange).not.toHaveBeenCalled();
	});

	it("refuses --rebase with --publish before reading anything", async () => {
		const dest = await staleCheckout({
			base: { "AGENTS.md": "a\n" },
			local: { "AGENTS.md": "mine\n" },
			published: { "AGENTS.md": "theirs\n" },
		});

		const result = await push(dest, "--rebase", "--publish");

		expect(result.code).toBe(2);
		expect(mocks.getPublished).not.toHaveBeenCalled();
		expect(mocks.publishChange).not.toHaveBeenCalled();
	});

	it("sends a clean merge against the published version and writes it into the checkout", async () => {
		mocks.submitChange.mockResolvedValue(accepted());
		const dest = await staleCheckout({
			base: { "AGENTS.md": "one\ntwo\nthree\n" },
			local: { "AGENTS.md": "ONE\ntwo\nthree\n" },
			published: { "AGENTS.md": "one\ntwo\nTHREE\n" },
		});
		const lockBefore = await lockOf(dest);

		const result = await push(dest, "--rebase");

		expect(result.code).toBe(0);
		const [, baseSnapshotId, changes] =
			mocks.submitChange.mock.calls[0] ?? [];
		expect(baseSnapshotId).toBe("snap-8");
		expect(changes).toEqual([
			{
				op: "put",
				path: "AGENTS.md",
				content: "ONE\ntwo\nTHREE\n",
				encoding: "utf8",
			},
		]);
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"ONE\ntwo\nTHREE\n",
		);
		expect(result.stdout).toContain("merged onto version 8");
		expect(result.stdout).toContain(
			"it still names version 7. `fabric instructions sync` moves it to the published version and keeps your merged edits.",
		);
		expect(result.stdout).not.toContain(
			"still names the published version",
		);
		expect(await lockOf(dest)).toBe(lockBefore);
	});

	it("carries an edit to a file only this checkout changed as it is", async () => {
		mocks.submitChange.mockResolvedValue(accepted());
		const dest = await staleCheckout({
			base: { "AGENTS.md": "a\n", "rules.md": "r\n" },
			local: { "AGENTS.md": "a\n", "rules.md": "mine\n" },
			published: { "AGENTS.md": "theirs\n", "rules.md": "r\n" },
		});

		const result = await push(dest, "--rebase");

		expect(result.code).toBe(0);
		const [, , changes] = mocks.submitChange.mock.calls[0] ?? [];
		expect(changes).toEqual([
			{
				op: "put",
				path: "rules.md",
				content: "mine\n",
				encoding: "utf8",
			},
		]);
		// Only the published side changed AGENTS.md: nothing here touches it.
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"a\n",
		);
	});

	it("writes conflict markers, sends nothing and leaves the lock alone", async () => {
		const dest = await staleCheckout({
			base: { "AGENTS.md": "one\ntwo\n" },
			local: { "AGENTS.md": "one\nmine\n" },
			published: { "AGENTS.md": "one\ntheirs\n" },
		});
		const lockBefore = await lockOf(dest);

		const result = await push(dest, "--rebase");

		expect(result.code).toBe(7);
		expect(mocks.submitChange).not.toHaveBeenCalled();
		const written = await readFile(path.join(dest, "AGENTS.md"), "utf8");
		expect(written).toContain("<<<<<<< local");
		expect(written).toContain("mine\n");
		expect(written).toContain("theirs\n");
		expect(written).toContain(">>>>>>> published-v8");
		expect(result.stdout).toContain("conflicts written into the file");
		expect(await lockOf(dest)).toBe(lockBefore);
	});

	it("takes a resolved file as the checkout holds it on the next run", async () => {
		mocks.submitChange.mockResolvedValue(accepted());
		const dest = await staleCheckout({
			base: { "AGENTS.md": "one\ntwo\n" },
			local: { "AGENTS.md": "one\nmine\n" },
			published: { "AGENTS.md": "one\ntheirs\n" },
		});
		expect((await push(dest, "--rebase")).code).toBe(7);

		const unresolved = await push(dest, "--rebase");
		expect(unresolved.code).toBe(7);
		expect(unresolved.stdout).toContain("still holding conflict markers");

		await writeFile(path.join(dest, "AGENTS.md"), "one\nboth\n");
		const resolved = await push(dest, "--rebase");

		expect(resolved.code).toBe(0);
		const [, baseSnapshotId, changes] =
			mocks.submitChange.mock.calls[0] ?? [];
		expect(baseSnapshotId).toBe("snap-8");
		expect(changes).toEqual([
			{
				op: "put",
				path: "AGENTS.md",
				content: "one\nboth\n",
				encoding: "utf8",
			},
		]);
		await expect(
			readFile(path.join(dest, ".fabric", "rebase.json"), "utf8"),
		).rejects.toThrow();
	});

	it("writes nothing and sends nothing on --dry-run", async () => {
		const dest = await staleCheckout({
			base: { "AGENTS.md": "one\ntwo\nthree\n" },
			local: { "AGENTS.md": "ONE\ntwo\nthree\n" },
			published: { "AGENTS.md": "one\ntwo\nTHREE\n" },
		});

		const result = await push(dest, "--rebase", "--dry-run");

		expect(result.code).toBe(0);
		expect(mocks.submitChange).not.toHaveBeenCalled();
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"ONE\ntwo\nthree\n",
		);
		expect(result.stdout).toContain("Would send");
	});

	it("names the removed version, not the project, when the server no longer keeps it", async () => {
		const dest = await staleCheckout({
			base: { "AGENTS.md": "one\ntwo\nthree\n" },
			local: { "AGENTS.md": "ONE\ntwo\nthree\n" },
			published: { "AGENTS.md": "one\ntwo\nTHREE\n" },
		});
		mocks.createVersionFileDownloadUrls.mockRejectedValue(
			Object.assign(new Error("Version not found"), { status: 404 }),
		);

		const result = await push(dest, "--rebase");

		expect(result.code).toBe(7);
		expect(result.stderr).toContain(
			"Version 7, which this folder last synced, is no longer kept",
		);
		expect(result.stderr).toContain("instructions sync");
		expect(result.stderr).not.toContain("Project not found");
		expect(mocks.submitChange).not.toHaveBeenCalled();
		expect(await readFile(path.join(dest, "AGENTS.md"), "utf8")).toBe(
			"ONE\ntwo\nthree\n",
		);
	});

	it("leaves a refusal other than a missing version to the usual sentence", async () => {
		const dest = await staleCheckout({
			base: { "AGENTS.md": "one\n" },
			local: { "AGENTS.md": "ONE\n" },
			published: { "AGENTS.md": "one\ntwo\n" },
		});
		mocks.createVersionFileDownloadUrls.mockRejectedValue(
			Object.assign(new Error("Forbidden"), { status: 403 }),
		);

		const result = await push(dest, "--rebase");

		expect(result.code).not.toBe(0);
		expect(result.stderr).not.toContain("no longer kept");
		expect(mocks.submitChange).not.toHaveBeenCalled();
	});

	it("refuses a lock that lists a file the synced version never held", async () => {
		const dest = await staleCheckout({
			base: { "AGENTS.md": "a\n" },
			ledger: { "AGENTS.md": "a\n", "secret.md": "s\n" },
			local: { "AGENTS.md": "mine\n", "secret.md": "private\n" },
			published: { "AGENTS.md": "a\n" },
		});

		const result = await push(dest, "--rebase");

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("does not match the published version");
		expect(mocks.submitChange).not.toHaveBeenCalled();
	});

	it("never sends a local override, merged or not", async () => {
		mocks.submitChange.mockResolvedValue(accepted());
		const dest = await staleCheckout({
			base: { "AGENTS.md": "a\n", "CLAUDE.md": "c\n" },
			local: { "AGENTS.md": "mine\n", "CLAUDE.md": "private\n" },
			published: { "AGENTS.md": "a\n", "CLAUDE.md": "c2\n" },
		});
		await writeFile(
			path.join(dest, ".fabric", "local-overrides.json"),
			JSON.stringify({ version: 1, paths: ["CLAUDE.md"], patterns: [] }),
		);

		const result = await push(dest, "--rebase");

		expect(result.code).toBe(0);
		const [, , changes] = mocks.submitChange.mock.calls[0] ?? [];
		expect(changes).toEqual([
			{
				op: "put",
				path: "AGENTS.md",
				content: "mine\n",
				encoding: "utf8",
			},
		]);
		expect(await readFile(path.join(dest, "CLAUDE.md"), "utf8")).toBe(
			"private\n",
		);
	});
});
