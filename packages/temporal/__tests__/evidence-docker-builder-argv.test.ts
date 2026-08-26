/**
 * docker-builder must never assemble a shell command string.
 *
 * The module builds `docker run` / `docker build` invocations around values
 * supplied by its callers (`projectDir`, `outputDir`, `dockerImage`). Running
 * those through `exec()` would hand them to a shell, which parses
 * metacharacters instead of passing them through as data. These tests pin the
 * argument-array form: every value has to arrive at the child process as one
 * argv entry, byte-for-byte, with no shell in the path.
 *
 * Lives here rather than in packages/evidence because that package has no test
 * runner of its own; @repo/evidence is a dependency of @repo/temporal.
 */

import {
	buildEvidenceProject,
	DEFAULT_DOCKER_IMAGE,
	ensureBuilderImage,
	isBuilderImageAvailable,
	isDockerAvailable,
} from "@repo/evidence";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * vi.hoisted so the shared state exists before the hoisted vi.mock factories
 * run — they execute during import resolution, ahead of any top-level const.
 */
const { execFileCalls, execFileControl } = vi.hoisted(() => ({
	/** Every (file, args) pair the module hands to child_process. */
	execFileCalls: [] as Array<{ file: string; args: string[] }>,
	execFileControl: {
		/**
		 * Set by a test to make matching calls reject, so paths that only run
		 * after a command fails (the ensureBuilderImage build fallback) can be
		 * reached.
		 */
		failWhen: null as null | ((file: string, args: string[]) => boolean),
	},
}));

type ExecFileCallback = (
	err: Error | null,
	result: { stdout: string; stderr: string },
) => void;

vi.mock("node:child_process", () => ({
	// Callback-shaped so promisify() wraps it the way it wraps the real one.
	execFile: (
		file: string,
		args: string[],
		optionsOrCallback: unknown,
		maybeCallback?: ExecFileCallback,
	) => {
		execFileCalls.push({ file, args });
		const callback =
			typeof optionsOrCallback === "function"
				? (optionsOrCallback as ExecFileCallback)
				: maybeCallback;
		const failed = execFileControl.failWhen?.(file, args) ?? false;
		callback?.(failed ? new Error("exit status 1") : null, {
			stdout: "",
			stderr: "",
		});
	},
}));

vi.mock("node:fs/promises", () => {
	const fsMock = {
		mkdir: vi.fn().mockResolvedValue(undefined),
		// Reported missing so the build resolves without touching a real
		// filesystem; these tests assert on the spawn arguments, not the result.
		access: vi.fn().mockRejectedValue(new Error("ENOENT")),
	};
	return { ...fsMock, default: fsMock };
});

beforeEach(() => {
	execFileCalls.length = 0;
	execFileControl.failWhen = null;
});

describe("evidence docker-builder argv handling", () => {
	it("passes the docker program and its arguments separately", async () => {
		await buildEvidenceProject({
			projectDir: "/tmp/fabric-evidence-report-1",
			outputDir: "/tmp/fabric-evidence-report-1-build",
		});

		expect(execFileCalls).toHaveLength(1);
		const [call] = execFileCalls;

		// The program name is its own argument — never part of a command string.
		expect(call.file).toBe("docker");
		expect(Array.isArray(call.args)).toBe(true);
		expect(call.args).toContain("run");
	});

	it("mounts paths as single unquoted argv entries", async () => {
		const projectDir = "/tmp/fabric evidence/report";
		const outputDir = "/tmp/fabric evidence/report-build";

		await buildEvidenceProject({ projectDir, outputDir });

		const [call] = execFileCalls;

		// Without a shell there is nothing to escape: a path containing spaces
		// travels as one argument, and adding quotes would make them literal.
		expect(call.args).toContain(`${projectDir}:/evidence`);
		expect(call.args).toContain(`${outputDir}:/output`);
		for (const arg of call.args) {
			expect(arg).not.toContain('"');
		}
	});

	it("keeps shell metacharacters inside a single argument", async () => {
		const projectDir = "/tmp/evidence; touch /tmp/pwned";
		const outputDir = "/tmp/evidence-$(id)-build";

		await buildEvidenceProject({ projectDir, outputDir });

		const [call] = execFileCalls;

		// Interpolation into a command string would have split these apart; as
		// argv entries they stay whole and are never parsed.
		expect(call.args).toContain(`${projectDir}:/evidence`);
		expect(call.args).toContain(`${outputDir}:/output`);
		expect(call.args.filter((a) => a === "-v")).toHaveLength(2);
	});

	it("runs the container-side shell over a fixed string", async () => {
		await buildEvidenceProject({
			projectDir: "/tmp/p",
			outputDir: "/tmp/p-build",
		});

		const [call] = execFileCalls;
		const shellIndex = call.args.indexOf("sh");

		// `sh -c` here executes inside the container. Its script is a constant,
		// so no caller value reaches a shell on either side of the boundary.
		expect(call.args[shellIndex + 1]).toBe("-c");
		expect(call.args[shellIndex + 2]).toBe(
			"npm install && npx evidence build --output /output",
		);
		expect(call.args[shellIndex + 2]).not.toContain("/tmp/p");
	});

	it("uses the default image when the caller supplies none", async () => {
		await buildEvidenceProject({
			projectDir: "/tmp/p",
			outputDir: "/tmp/p-build",
		});

		expect(execFileCalls[0].args).toContain(DEFAULT_DOCKER_IMAGE);
	});
});

describe("evidence docker-builder argv layout of the other commands", () => {
	it("checks for docker without a version string to parse", async () => {
		await expect(isDockerAvailable()).resolves.toBe(true);

		expect(execFileCalls).toEqual([
			{ file: "docker", args: ["--version"] },
		]);
	});

	it("inspects an image as three separate arguments", async () => {
		const image = "ghcr.io/example/evidence:1.2.3";

		await expect(isBuilderImageAvailable(image)).resolves.toBe(true);

		expect(execFileCalls).toEqual([
			{ file: "docker", args: ["image", "inspect", image] },
		]);
	});

	it("builds the image with argv when inspect reports it missing", async () => {
		const image = "ghcr.io/example/evidence:1.2.3";
		execFileControl.failWhen = (_file, args) => args[0] === "image";

		await ensureBuilderImage(image);

		expect(execFileCalls).toHaveLength(2);
		const build = execFileCalls[1];
		expect(build.file).toBe("docker");
		// ["build", "-t", <image>, <dockerfile dir>] — the tag value is its own
		// argument, so a reference can never merge with the -t flag.
		expect(build.args).toHaveLength(4);
		expect(build.args.slice(0, 3)).toEqual(["build", "-t", image]);
		expect(build.args[3]).toMatch(/docker$/);
	});

	it("skips the build when the image already exists", async () => {
		await ensureBuilderImage("ghcr.io/example/evidence:1.2.3");

		expect(execFileCalls).toHaveLength(1);
		expect(execFileCalls[0].args[0]).toBe("image");
	});

	// The local-CLI path refuses to run on Windows rather than reaching for the
	// npm/npx .cmd shims, which Node cannot launch without a shell.
	it.runIf(process.platform !== "win32")(
		"runs the local CLI with the output path as one argument",
		async () => {
			const outputDir = "/tmp/local; touch /tmp/pwned";

			await buildEvidenceProject({
				projectDir: "/tmp/local-project",
				outputDir,
				useLocalCli: true,
			});

			expect(execFileCalls).toEqual([
				{ file: "npm", args: ["install"] },
				{
					file: "npx",
					args: ["evidence", "build", "--output", outputDir],
				},
			]);
		},
	);

	it.runIf(process.platform === "win32")(
		"reports the local CLI as unsupported on Windows",
		async () => {
			const result = await buildEvidenceProject({
				projectDir: "C:\\tmp\\local-project",
				outputDir: "C:\\tmp\\local-build",
				useLocalCli: true,
			});

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/not supported on Windows/);
			expect(execFileCalls).toHaveLength(0);
		},
	);
});

describe("evidence docker-builder image reference validation", () => {
	// The check is narrow on purpose: it covers what argv itself can misread,
	// not OCI reference grammar. A leading "-" is the real hazard — docker would
	// read it as an option. Control characters are refused because they would
	// corrupt the error text quoting them.
	const rejected = ["-v/etc:/host", "--privileged", "image\nname", ""];

	it.each(rejected)("refuses to run a container for %j", async (image) => {
		const result = await buildEvidenceProject({
			projectDir: "/tmp/p",
			outputDir: "/tmp/p-build",
			dockerImage: image,
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/Invalid Docker image reference/);
		expect(execFileCalls).toHaveLength(0);
	});

	it.each(rejected)(
		"reports %j as unavailable without spawning",
		async (image) => {
			await expect(isBuilderImageAvailable(image)).resolves.toBe(false);
			expect(execFileCalls).toHaveLength(0);
		},
	);

	it.each(rejected)("refuses to build an image named %j", async (image) => {
		await expect(ensureBuilderImage(image)).rejects.toThrow(
			/Invalid Docker image reference/,
		);
		expect(execFileCalls).toHaveLength(0);
	});

	// Reference syntax is docker's to judge. These all reach argv intact,
	// including shapes a hand-rolled OCI pattern tends to reject by accident.
	it.each([
		"fabric-evidence-builder:latest",
		"ghcr.io/example/evidence:1.2.3",
		"registry.example.com:5000/team/evidence:latest",
		"[2001:db8::1]:5000/team/evidence:latest",
		`evidence@sha256:${"a".repeat(64)}`,
	])("passes the reference %j through untouched", async (image) => {
		await buildEvidenceProject({
			projectDir: "/tmp/p",
			outputDir: "/tmp/p-build",
			dockerImage: image,
		});

		expect(execFileCalls).toHaveLength(1);
		expect(execFileCalls[0].args).toContain(image);
	});
});
