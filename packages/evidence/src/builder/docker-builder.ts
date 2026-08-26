/**
 * Docker Builder for Evidence Projects
 *
 * Runs `evidence build` in a Docker container to generate static output.
 */

import { execFile as execFileCallback } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

/**
 * Every child process in this module goes through execFile, never exec.
 *
 * exec() spawns a shell, so any interpolated value is parsed for shell
 * metacharacters instead of being passed through as data. execFile() takes an
 * argument array and hands it to the program directly — no shell, no parsing.
 * Several values reaching these calls (`projectDir`, `outputDir`,
 * `dockerImage`) arrive from callers of the exported API, so the safety of a
 * command string here would depend on a sanitizer living in a different
 * package. Keep the argument-array form for any command added below.
 */
const execFile = promisify(execFileCallback);

/**
 * The local-CLI build path is POSIX-only, and says so rather than failing
 * obscurely.
 *
 * npm and npx ship as `.cmd` shims on Windows, and Node refuses to spawn a
 * `.cmd` without `shell: true` (the CVE-2024-27980 hardening). Turning the
 * shell back on would restore the exact injection surface this module exists to
 * avoid, so naming `npm.cmd` here would only trade one failure for a more
 * confusing one. Windows should use the Docker path, which shells out to
 * nothing on the host.
 */
const LOCAL_CLI_UNSUPPORTED_ON_WINDOWS =
	"Local Evidence CLI builds are not supported on Windows: the npm/npx shims " +
	"would need a shell to launch, which this builder deliberately avoids. " +
	"Use the Docker build path instead.";

/**
 * Build options for Evidence project
 */
export interface BuildOptions {
	/** Path to the Evidence project directory */
	projectDir: string;

	/** Path to output the built static site */
	outputDir: string;

	/** Docker image to use for building */
	dockerImage?: string;

	/** Timeout in milliseconds (default: 5 minutes) */
	timeout?: number;

	/** Whether to use local Evidence CLI instead of Docker */
	useLocalCli?: boolean;
}

/**
 * Build result
 */
export interface BuildResult {
	success: boolean;
	outputDir: string;
	duration: number;
	error?: string;
	stdout?: string;
	stderr?: string;
}

/**
 * Default Docker image for Evidence builds
 */
export const DEFAULT_DOCKER_IMAGE = "fabric-evidence-builder:latest";

/**
 * True for C0 controls and DEL, which are never legitimate in an image
 * reference and would corrupt the error text that quotes the rejected value.
 * A code-point scan rather than a regex range, so no invisible byte has to be
 * written into this file to express it.
 */
function hasControlCharacter(value: string): boolean {
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) {
			return true;
		}
	}
	return false;
}

/**
 * Reject an image reference that argv itself would misread.
 *
 * Dropping the shell stops metacharacters from being interpreted, but it does
 * not change how docker parses its own arguments: a reference beginning with
 * `-` lands in a flag position, where something like `--privileged` would be
 * honored as an option instead of read as a name. That is the entire
 * argv-injection surface here, and the image is caller-supplied
 * (`BuildOptions.dockerImage`, and the `image` parameter of the two exported
 * image helpers), so it is checked before reaching an argument slot.
 *
 * Deliberately not an OCI-reference validator. Reference grammar is wider than
 * it looks — bracketed IPv6 registry hosts, `+` in a digest algorithm, `=` in
 * an encoded digest — so a hand-rolled pattern rejects valid references while
 * still admitting invalid ones. A malformed reference is not a security
 * problem: it stays one argument, and docker reports it more precisely than a
 * local approximation could.
 */
function assertValidImageReference(image: string): void {
	if (image === "" || image.startsWith("-") || hasControlCharacter(image)) {
		throw new Error(
			`Invalid Docker image reference: ${JSON.stringify(image)}`,
		);
	}
}

/**
 * Build an Evidence project using Docker
 */
export async function buildEvidenceProject(
	options: BuildOptions,
): Promise<BuildResult> {
	const {
		projectDir,
		outputDir,
		dockerImage = DEFAULT_DOCKER_IMAGE,
		timeout = 5 * 60 * 1000, // 5 minutes
		useLocalCli = false,
	} = options;

	const startTime = Date.now();

	try {
		// Ensure output directory exists
		await fs.mkdir(outputDir, { recursive: true });

		if (useLocalCli) {
			return await buildWithLocalCli(projectDir, outputDir, timeout);
		}

		return await buildWithDocker(
			projectDir,
			outputDir,
			dockerImage,
			timeout,
		);
	} catch (error) {
		const duration = Date.now() - startTime;
		return {
			success: false,
			outputDir,
			duration,
			error: error instanceof Error ? error.message : "Build failed",
		};
	}
}

/**
 * Build using Docker container
 */
async function buildWithDocker(
	projectDir: string,
	outputDir: string,
	dockerImage: string,
	timeout: number,
): Promise<BuildResult> {
	const startTime = Date.now();

	assertValidImageReference(dockerImage);

	// Docker run arguments. Mount project as /evidence and output as /output.
	// No quoting: these go straight to docker as separate argv entries, so a
	// path containing spaces needs no escaping.
	const args = [
		"run",
		"--rm",
		"-v",
		`${projectDir}:/evidence`,
		"-v",
		`${outputDir}:/output`,
		"-w",
		"/evidence",
		dockerImage,
		// This shell runs inside the container, over a fixed string.
		"sh",
		"-c",
		"npm install && npx evidence build --output /output",
	];

	try {
		const { stdout, stderr } = await execFile("docker", args, {
			timeout,
			maxBuffer: 10 * 1024 * 1024, // 10MB buffer
		});

		const duration = Date.now() - startTime;

		// Check if build output exists
		const indexPath = path.join(outputDir, "index.html");
		const indexExists = await fileExists(indexPath);

		return {
			success: indexExists,
			outputDir,
			duration,
			stdout,
			stderr,
			error: indexExists
				? undefined
				: "Build completed but no output found",
		};
	} catch (error) {
		const duration = Date.now() - startTime;
		const execError = error as {
			stdout?: string;
			stderr?: string;
			message: string;
		};

		return {
			success: false,
			outputDir,
			duration,
			stdout: execError.stdout,
			stderr: execError.stderr,
			error: execError.message,
		};
	}
}

/**
 * Build using local Evidence CLI (for development)
 */
async function buildWithLocalCli(
	projectDir: string,
	outputDir: string,
	timeout: number,
): Promise<BuildResult> {
	const startTime = Date.now();

	if (process.platform === "win32") {
		throw new Error(LOCAL_CLI_UNSUPPORTED_ON_WINDOWS);
	}

	try {
		// Install dependencies
		await execFile("npm", ["install"], {
			cwd: projectDir,
			timeout: timeout / 2,
		});

		// Run Evidence build
		const { stdout, stderr } = await execFile(
			"npx",
			["evidence", "build", "--output", outputDir],
			{
				cwd: projectDir,
				timeout: timeout / 2,
				maxBuffer: 10 * 1024 * 1024,
			},
		);

		const duration = Date.now() - startTime;

		// Check if build output exists
		const indexPath = path.join(outputDir, "index.html");
		const indexExists = await fileExists(indexPath);

		return {
			success: indexExists,
			outputDir,
			duration,
			stdout,
			stderr,
			error: indexExists
				? undefined
				: "Build completed but no output found",
		};
	} catch (error) {
		const duration = Date.now() - startTime;
		const execError = error as {
			stdout?: string;
			stderr?: string;
			message: string;
		};

		return {
			success: false,
			outputDir,
			duration,
			stdout: execError.stdout,
			stderr: execError.stderr,
			error: execError.message,
		};
	}
}

/**
 * Check if Docker is available
 */
export async function isDockerAvailable(): Promise<boolean> {
	try {
		await execFile("docker", ["--version"]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if the Evidence builder image exists
 */
export async function isBuilderImageAvailable(
	image: string = DEFAULT_DOCKER_IMAGE,
): Promise<boolean> {
	try {
		assertValidImageReference(image);
		await execFile("docker", ["image", "inspect", image]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Pull or build the Evidence builder image
 */
export async function ensureBuilderImage(
	image: string = DEFAULT_DOCKER_IMAGE,
): Promise<void> {
	// Validate up front: isBuilderImageAvailable reports a rejected reference as
	// "not available", which would otherwise fall through to a build attempt.
	assertValidImageReference(image);

	const exists = await isBuilderImageAvailable(image);
	if (exists) {
		return;
	}

	// Build the image from Dockerfile
	// This assumes a Dockerfile exists in the expected location
	const dockerfileDir = path.join(__dirname, "../../docker");

	try {
		await execFile("docker", ["build", "-t", image, dockerfileDir], {
			timeout: 10 * 60 * 1000, // 10 minutes for image build
		});
	} catch (error) {
		throw new Error(
			`Failed to build Evidence builder image: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Check if a file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Read the built index.html content
 */
export async function readBuildOutput(
	outputDir: string,
): Promise<{ html: string; assets: string[] } | null> {
	try {
		const indexPath = path.join(outputDir, "index.html");
		const html = await fs.readFile(indexPath, "utf-8");

		// List assets in the build directory
		const assets: string[] = [];
		const items = await fs.readdir(outputDir, { withFileTypes: true });

		for (const item of items) {
			if (item.name !== "index.html") {
				assets.push(item.name);
			}
		}

		return { html, assets };
	} catch {
		return null;
	}
}

/**
 * Package build output as a single self-contained HTML file
 * (inlines CSS and JS for simple embedding)
 */
export async function packageAsInlineHtml(
	outputDir: string,
): Promise<string | null> {
	const output = await readBuildOutput(outputDir);
	if (!output) {
		return null;
	}

	// For now, just return the index.html
	// A more sophisticated version would inline CSS/JS
	return output.html;
}
