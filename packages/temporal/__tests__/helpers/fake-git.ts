import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * A stand-in `git` that the code under test finds through `PATH`, for the
 * cases a real git cannot produce on demand: one that never answers (a hung
 * transport the watchdog must kill) and one that fails with a provider's exact
 * wording.
 *
 * `hang`: never answers.
 * `fail-unless-init`: `init` succeeds; any other call prints `FAKE_GIT_STDERR`
 * to stderr and exits 128, as git does for an HTTP refusal.
 */
type FakeGitBehavior = "hang" | "fail-unless-init";

const POSIX_SCRIPTS: Record<FakeGitBehavior, () => string> = {
	// `sleep` is named by absolute path because PATH holds only the fake bin.
	hang: () => {
		const sleepBin = execFileSync("sh", ["-c", "command -v sleep"], {
			encoding: "utf8",
		}).trim();
		return `#!/bin/sh\nexec ${sleepBin} 30\n`;
	},
	"fail-unless-init": () =>
		[
			"#!/bin/sh",
			'for a in "$@"; do [ "$a" = init ] && exit 0; done',
			'printf "%s\\n" "$FAKE_GIT_STDERR" >&2',
			"exit 128",
			"",
		].join("\n"),
};

// The same behaviours for Windows, where a spawn resolves a command name only
// to a `.exe` (a `#!/bin/sh` script named `git` is not found). `git.exe` is a
// copy of node.exe and this script is preloaded through NODE_OPTIONS, so it
// runs before node reads git's `-c ...` arguments as its own. Each ends the
// process or blocks it: node would otherwise go on to fail on those arguments.
const WINDOWS_PRELOADS: Record<FakeGitBehavior, string> = {
	hang: "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);\n",
	"fail-unless-init": [
		'if (process.argv.includes("init")) {',
		"	process.exit(0);",
		"}",
		'process.stderr.write(process.env.FAKE_GIT_STDERR + "\\n");',
		"process.exit(128);",
		"",
	].join("\n"),
};

/**
 * Installs the stand-in under `root/fake-bin` and returns the environment that
 * makes a spawned `git` resolve to it: spread it over the child's env.
 */
export async function installFakeGit(
	root: string,
	behavior: FakeGitBehavior,
): Promise<NodeJS.ProcessEnv> {
	const bin = path.join(root, "fake-bin");
	await mkdir(bin, { recursive: true });
	if (process.platform !== "win32") {
		const file = path.join(bin, "git");
		await writeFile(file, POSIX_SCRIPTS[behavior]());
		await chmod(file, 0o755);
		return { PATH: bin };
	}
	const preload = path.join(bin, "fake-git.cjs");
	await writeFile(preload, WINDOWS_PRELOADS[behavior]);
	await copyFile(process.execPath, path.join(bin, "git.exe"));
	return {
		PATH: bin,
		NODE_OPTIONS: `--require "${preload.split("\\").join("/")}"`,
	};
}
