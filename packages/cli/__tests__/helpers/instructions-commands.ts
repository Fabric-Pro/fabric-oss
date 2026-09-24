/**
 * Shared harness for the `fabric instructions <command>` end-to-end tests
 * (originally Fizzy #2539; split by subject into `instructions-*.test.ts`
 * files under Fizzy #2698), with the SDK client mocked at the `getClient`
 * boundary.
 *
 * `vi.mock` calls are hoisted above every import in a file — not only above
 * local `const`s, but also above a dynamic `import()` written inside the
 * factory itself, which additionally deadlocks here because this module
 * transitively imports the very modules (`../src/lib/client.js` and
 * `../src/lib/config.js`) a consumer mocks. So each consumer keeps its own
 * `vi.hoisted(() => ({ mocks: { getPublished: vi.fn(), ... } }))` and its own
 * two inline `vi.mock(...)` factory bodies (see `instructions-check.test.ts`
 * for the canonical shape) — only `resetInstructionsMocks` and the fixtures
 * below that do not need to run inside a mock factory live here.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { zipSync } from "fflate";
import { vi } from "vitest";
import { buildInstructionsCommand } from "../../src/commands/instructions/index.js";
import { computeSnapshotDigest } from "../../src/lib/instructions/manifest.js";

/**
 * Where the CLI keeps its key in these tests — deliberately outside any
 * destination, and written without a literal home directory: this repository
 * is public and its publication scan refuses one.
 */
const OUTSIDE_CONFIG_PATH = path.join(tmpdir(), "fabricai", "config.json");

export interface InstructionsMocks {
	getPublished: ReturnType<typeof vi.fn>;
	createDownloadUrl: ReturnType<typeof vi.fn>;
	getApiKey: ReturnType<typeof vi.fn<() => string | undefined>>;
	getConfigPath: ReturnType<typeof vi.fn<() => string>>;
	getDefaultContext: ReturnType<typeof vi.fn<() => unknown>>;
	/** Proves the ambient SDK context is dropped (round 3, finding 3). */
	withoutContext: ReturnType<typeof vi.fn>;
	/**
	 * Every `getClient` options object, in call order. The manifest read
	 * and the download-link request deliberately get DIFFERENT clients —
	 * different budget, different retry policy — and that is only visible
	 * here.
	 */
	getClient: ReturnType<typeof vi.fn>;
}

/** Call from each file's `beforeEach`. */
export function resetInstructionsMocks(mocks: InstructionsMocks): void {
	mocks.getPublished.mockReset();
	mocks.createDownloadUrl.mockReset();
	mocks.getApiKey.mockReset();
	mocks.getApiKey.mockReturnValue("fab_test");
	mocks.getConfigPath.mockReset();
	mocks.getConfigPath.mockReturnValue(OUTSIDE_CONFIG_PATH);
	mocks.getDefaultContext.mockReset();
	mocks.getDefaultContext.mockReturnValue(undefined);
	mocks.getClient.mockReset();
	delete process.env.FABRIC_FORMAT;
	delete process.env.FABRIC_DEBUG;
}

class ExitSignal extends Error {
	constructor(readonly code: number) {
		super(`exit ${code}`);
	}
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * The instructions command mounted the way `bin/fabric.ts` mounts it.
 *
 * The root option's default is `FABRIC_FORMAT ?? "table"`, which is the ONLY
 * route by which the environment reaches these commands (review round 2,
 * finding 10). Running the subcommand on its own would leave
 * `optsWithGlobals()` with no parent to read and quietly prove nothing about
 * how the real binary behaves.
 */
function programWithInstructions(): Command {
	const program = new Command("fabric")
		.exitOverride()
		.option(
			"--format <format>",
			"Output format: table|json|yaml|csv",
			process.env.FABRIC_FORMAT ?? "table",
		);
	program.addCommand(buildInstructionsCommand());
	return program;
}

export async function runCli(
	argv: string[],
	globals: string[] = [],
): Promise<RunResult> {
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
		await programWithInstructions().parseAsync(
			[...globals, "instructions", ...argv],
			{ from: "user" },
		);
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

export function sha256(text: string): string {
	return createHash("sha256").update(Buffer.from(text)).digest("hex");
}

export function manifestEntry(filePath: string, contents: string) {
	return {
		path: filePath,
		sha256: sha256(contents),
		size: Buffer.byteLength(contents),
		mode: 0o100644,
		kind: "INSTRUCTIONS" as const,
	};
}

/**
 * A snapshot header that AGREES with its manifest.
 *
 * `assertValidManifest` recomputes the digest and checks the file count, so
 * a fixture that hand-writes a digest would now be refused — which is the
 * point of the check, and means every sync fixture has to be built this way.
 */
export function snapshotFor(
	manifest: ReturnType<typeof manifestEntry>[],
	version = 7,
) {
	return {
		id: "snap-2",
		version,
		digest: computeSnapshotDigest(manifest),
		fileCount: manifest.length,
		publishedAt: null,
	};
}

export async function makeTree(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), "fabric-cmd-"));
}

export async function seedLock(
	dest: string,
	digest: string,
	files: Record<string, { sha256: string; mode: number | null; kept?: true }>,
	projectId = "project-1",
): Promise<void> {
	await seedRawLock(
		dest,
		JSON.stringify(
			{
				version: Object.values(files).some((file) => file.kept) ? 2 : 1,
				projectId,
				snapshotId: "snap-1",
				snapshotVersion: 6,
				digest,
				syncedAt: "2026-09-16T10:00:00.000Z",
				files,
			},
			null,
			2,
		),
	);
}

export async function seedRawLock(dest: string, body: string): Promise<void> {
	await mkdir(path.join(dest, ".fabric"), { recursive: true });
	await writeFile(
		path.join(dest, ".fabric", "instructions.lock"),
		body,
		"utf8",
	);
}

/**
 * Serve one zip from the stubbed global fetch the bundle download uses.
 * `beforeServe` runs inside the download, after the plan was made and before
 * any write: the window an editor's save can land in (Decision 37).
 */
export function stubBundle(
	files: Record<string, string>,
	beforeServe?: () => Promise<void>,
): void {
	const archive = zipSync(
		Object.fromEntries(
			Object.entries(files).map(([key, value]) => [
				key,
				new Uint8Array(Buffer.from(value)),
			]),
		),
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			await beforeServe?.();
			return new Response(archive.slice().buffer, { status: 200 });
		}),
	);
}
