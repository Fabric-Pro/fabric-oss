import { spawnSync } from "node:child_process";
import {
	lstatSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";

const root = process.cwd();
const installCommand = "pnpm install --frozen-lockfile";

class SetupError extends Error {}

/** @param {string} reason */
function failSetup(reason) {
	throw new SetupError(
		`Type-check setup is stale: ${reason}. Run \`${installCommand}\` and retry.`,
	);
}

/** @param {string} directory @returns {string[]} */
function findPackageFiles(directory) {
	const packageFiles = [];
	const ignoredDirectories = new Set([".git", "node_modules"]);
	const pending = [directory];

	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) {
			continue;
		}

		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) {
				pending.push(path);
			} else if (entry.isFile() && entry.name === "package.json") {
				packageFiles.push(path);
			}
		}
	}

	return packageFiles;
}

/** @param {string} value */
function unquote(value) {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function workspacePatterns() {
	let contents;
	try {
		contents = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
	} catch {
		failSetup("could not read pnpm-workspace.yaml");
	}

	const patterns = [];
	let inPackages = false;
	for (const line of contents.split(/\r?\n/)) {
		if (!inPackages) {
			inPackages = line.trim() === "packages:";
			continue;
		}

		const match = line.match(/^\s+-\s+(.+?)\s*(?:#.*)?$/);
		if (match) {
			patterns.push(unquote(match[1]));
			continue;
		}
		if (line.trim() && !line.startsWith(" ") && !line.startsWith("\t")) {
			break;
		}
	}

	if (patterns.length === 0) {
		failSetup("pnpm-workspace.yaml has no package patterns");
	}
	return patterns;
}

/** @param {string} pattern @param {string} path */
function matchesWorkspacePattern(pattern, path) {
	const patternSegments = pattern.split("/");
	const pathSegments = path.split("/");

	/** @param {number} patternIndex @param {number} pathIndex */
	function matches(patternIndex, pathIndex) {
		if (patternIndex === patternSegments.length) {
			return pathIndex === pathSegments.length;
		}
		if (patternSegments[patternIndex] === "**") {
			return (
				matches(patternIndex + 1, pathIndex) ||
				(pathIndex < pathSegments.length &&
					matches(patternIndex, pathIndex + 1))
			);
		}
		if (pathIndex === pathSegments.length) {
			return false;
		}
		const segment = patternSegments[patternIndex].replace(
			/[|\\{}()[\]^$+?.]/g,
			"\\$&",
		);
		return (
			new RegExp(`^${segment.replaceAll("*", "[^/]*")}$`).test(
				pathSegments[pathIndex],
			) && matches(patternIndex + 1, pathIndex + 1)
		);
	}

	return matches(0, 0);
}

/** @param {string} directory @param {string[]} patterns */
function isWorkspaceMember(directory, patterns) {
	const path = relative(root, directory).split("\\").join("/");
	if (!path) {
		return true;
	}
	return (
		patterns.some(
			(pattern) =>
				!pattern.startsWith("!") &&
				matchesWorkspacePattern(pattern, path),
		) &&
		!patterns.some(
			(pattern) =>
				pattern.startsWith("!") &&
				matchesWorkspacePattern(pattern.slice(1), path),
		)
	);
}

/** @param {string} reference */
function workspaceAliasName(reference) {
	if (reference.startsWith("@")) {
		const separator = reference.indexOf("@", 1);
		return separator > 1 ? reference.slice(0, separator) : undefined;
	}

	const separator = reference.indexOf("@");
	return separator > 0 ? reference.slice(0, separator) : undefined;
}

/**
 * @param {string} dependencyName
 * @param {string} specifier
 * @param {string} directory
 * @param {Map<string, string>} workspacePackages
 * @param {Set<string>} workspaceDirectories
 */
function resolveWorkspaceTarget(
	dependencyName,
	specifier,
	directory,
	workspacePackages,
	workspaceDirectories,
) {
	const reference = specifier.slice("workspace:".length);
	if (reference.startsWith(".") || reference.startsWith("/")) {
		const target = resolve(directory, reference);
		return workspaceDirectories.has(target) ? target : undefined;
	}
	const alias = workspaceAliasName(reference);
	return alias
		? workspacePackages.get(alias)
		: workspacePackages.get(dependencyName);
}

/** @param {string} packageFile */
function readPackage(packageFile) {
	try {
		return JSON.parse(readFileSync(packageFile, "utf8"));
	} catch {
		failSetup(
			`could not read ${relative(root, packageFile) || "package.json"}`,
		);
	}
}

function validatePnpmInstall() {
	const lockfile = join(root, "pnpm-lock.yaml");
	const snapshot = join(root, "node_modules/.pnpm/lock.yaml");

	try {
		if (!statSync(snapshot).isFile()) {
			failSetup("node_modules/.pnpm/lock.yaml is missing");
		}
	} catch {
		failSetup("node_modules/.pnpm/lock.yaml is missing");
	}

	let rootLock;
	let installedLock;
	try {
		rootLock = readFileSync(lockfile);
		installedLock = readFileSync(snapshot);
	} catch {
		failSetup(
			"could not compare pnpm-lock.yaml with node_modules/.pnpm/lock.yaml",
		);
	}
	if (!rootLock.equals(installedLock)) {
		failSetup("pnpm-lock.yaml does not match node_modules/.pnpm/lock.yaml");
	}

	const patterns = workspacePatterns();
	const packages = findPackageFiles(root)
		.map((packageFile) => ({
			packageFile,
			directory: resolve(packageFile, ".."),
		}))
		.filter(({ directory }) => isWorkspaceMember(directory, patterns))
		.map(({ packageFile, directory }) => ({
			directory,
			manifest: readPackage(packageFile),
		}));
	const workspacePackages = new Map(
		packages
			.filter(({ manifest }) => typeof manifest.name === "string")
			.map(({ directory, manifest }) => [manifest.name, directory]),
	);
	const workspaceDirectories = new Set(workspacePackages.values());

	for (const { directory, manifest } of packages) {
		const dependencies = [
			manifest.dependencies,
			manifest.devDependencies,
			manifest.optionalDependencies,
			manifest.peerDependencies,
		].filter(Boolean);
		for (const dependencyGroup of dependencies) {
			for (const [name, specifier] of Object.entries(dependencyGroup)) {
				if (
					typeof specifier !== "string" ||
					!specifier.startsWith("workspace:")
				) {
					continue;
				}

				const target = resolveWorkspaceTarget(
					name,
					specifier,
					directory,
					workspacePackages,
					workspaceDirectories,
				);
				const link = join(directory, "node_modules", name);
				if (!target) {
					failSetup(
						`workspace dependency ${name} from ${relative(root, directory)} has no workspace package`,
					);
				}

				try {
					if (
						!lstatSync(link).isSymbolicLink() ||
						realpathSync(link) !== realpathSync(target)
					) {
						failSetup(
							`workspace link for ${name} from ${relative(root, directory)} is missing or wrong`,
						);
					}
				} catch {
					failSetup(
						`workspace link for ${name} from ${relative(root, directory)} is missing or wrong`,
					);
				}
			}
		}
	}
}

function nodeOptions() {
	const existing = process.env.NODE_OPTIONS ?? "";
	if (
		/(?:^|\s|["'])--max(?:-|_)old(?:-|_)space(?:-|_)size(?:=|\s|$)/.test(
			existing,
		)
	) {
		return existing;
	}
	return existing
		? `${existing} --max-old-space-size=12288`
		: "--max-old-space-size=12288";
}

function main() {
	const [mode, ...forwardedArgs] = process.argv.slice(2);
	const changed = mode === "--changed";
	const extraArgs = changed ? forwardedArgs : process.argv.slice(2);

	validatePnpmInstall();

	const concurrency = process.env.TURBO_CONCURRENCY ?? "4";
	const turboBin = createRequire(import.meta.url).resolve("turbo/bin/turbo");
	const turboArgs = ["type-check", `--concurrency=${concurrency}`];
	if (changed) {
		turboArgs.push("--filter=...[origin/master]");
	}
	turboArgs.push(...extraArgs);

	const result = spawnSync(process.execPath, [turboBin, ...turboArgs], {
		env: {
			...process.env,
			NODE_OPTIONS: nodeOptions(),
			...(changed ? {} : { NEXT_TYPECHECK_SPLIT: "true" }),
		},
		stdio: "inherit",
	});

	if (result.error) {
		throw result.error;
	}
	process.exitCode = result.status ?? 1;
}

try {
	main();
} catch (error) {
	if (error instanceof SetupError) {
		writeSync(process.stderr.fd, `${error.message}\n`);
		process.exitCode = 1;
	} else {
		throw error;
	}
}
