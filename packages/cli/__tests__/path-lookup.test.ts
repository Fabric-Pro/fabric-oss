/**
 * `isOnPath` — is an executable reachable on PATH, answered with `stat` alone.
 *
 * The Windows rules are exercised here on whatever machine runs the suite:
 * the platform and the environment are inputs, and so is the `stat` the
 * lookup asks. A Windows lookup joins candidates with `path.win32`, which on
 * a POSIX machine are not real paths, so the injected `stat` maps each
 * candidate onto a real temp directory — and records it, which is how the
 * tests see which candidates were tried, in which order.
 */
import { chmod, mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	isOnPath,
	type PathLookupEnvironment,
} from "../src/lib/instructions/path-lookup.js";

let binDir: string;

beforeAll(async () => {
	binDir = await realpath(
		await mkdtemp(path.join(tmpdir(), "fabric-path-lookup-")),
	);
	// Mode 0644 throughout: on Windows the extension decides, not a mode bit.
	for (const name of ["tool.CMD", "script.PS1", "bare"]) {
		await writeFile(path.join(binDir, name), "@echo off\r\n", "utf8");
		await chmod(path.join(binDir, name), 0o644);
	}
});

/**
 * A Windows lookup whose PATH holds `binDir`, quoted the way Windows allows,
 * between a relative entry and an empty one (both ignored), under the key
 * spellings Windows actually uses.
 */
function windows(
	env: Record<string, string | undefined> = {},
): PathLookupEnvironment & { tried: string[] } {
	const tried: string[] = [];
	return {
		platform: "win32",
		env: {
			Path: `relative\\dir;"${binDir}";`,
			PathExt: ".COM;.EXE;.CMD",
			...env,
		},
		tried,
		stat: async (candidate) => {
			tried.push(candidate);
			// `\tmp\...\tool.CMD` → `/tmp/.../tool.CMD`.
			return stat(candidate.replaceAll("\\", "/"));
		},
	};
}

describe("isOnPath on win32", () => {
	it("finds a name through PATHEXT, trying each extension in order, with no execute bit", async () => {
		const lookup = windows();

		await expect(isOnPath("tool", lookup)).resolves.toBe(true);

		expect(lookup.tried).toEqual([
			path.win32.join(binDir, "tool.COM"),
			path.win32.join(binDir, "tool.EXE"),
			path.win32.join(binDir, "tool.CMD"),
		]);
	});

	it("honours the PATHEXT list it is given, not a fixed one", async () => {
		await expect(isOnPath("script", windows())).resolves.toBe(false);
		await expect(
			isOnPath("script", windows({ PathExt: ".CMD;.PS1" })),
		).resolves.toBe(true);
	});

	it("falls back to the default PATHEXT when none is set", async () => {
		const lookup = windows({ PathExt: undefined });

		await expect(isOnPath("tool", lookup)).resolves.toBe(true);
		expect(
			lookup.tried.map((candidate) => path.win32.extname(candidate)),
		).toEqual([".COM", ".EXE", ".BAT", ".CMD"]);
	});

	it("tries a name that already carries a PATHEXT extension as it is", async () => {
		const lookup = windows({ PathExt: ".com;.exe;.cmd" });

		await expect(isOnPath("tool.CMD", lookup)).resolves.toBe(true);
		expect(lookup.tried).toEqual([path.win32.join(binDir, "tool.CMD")]);
	});

	it("never tries a bare name without an extension", async () => {
		const lookup = windows();

		await expect(isOnPath("bare", lookup)).resolves.toBe(false);
		expect(lookup.tried).not.toContain(path.win32.join(binDir, "bare"));
	});

	it("searches only absolute entries of a ;-separated PATH", async () => {
		const lookup = windows({ Path: `relative\\dir;${binDir}` });
		await expect(isOnPath("tool", lookup)).resolves.toBe(true);
		expect(
			lookup.tried.every((candidate) =>
				candidate.startsWith(path.win32.normalize(binDir)),
			),
		).toBe(true);

		const relativeOnly = windows({ Path: "relative\\dir;.;" });
		await expect(isOnPath("tool", relativeOnly)).resolves.toBe(false);
		expect(relativeOnly.tried).toEqual([]);
	});
});

describe("isOnPath on POSIX, same files", () => {
	it("requires an execute bit and ignores PATHEXT", async () => {
		const lookup: PathLookupEnvironment = {
			platform: "linux",
			env: { PATH: binDir, PATHEXT: ".CMD" },
		};

		await expect(isOnPath("tool", lookup)).resolves.toBe(false);
		await expect(isOnPath("tool.CMD", lookup)).resolves.toBe(false);

		await chmod(path.join(binDir, "bare"), 0o755);
		try {
			await expect(isOnPath("bare", lookup)).resolves.toBe(true);
		} finally {
			await chmod(path.join(binDir, "bare"), 0o644);
		}
	});
});
