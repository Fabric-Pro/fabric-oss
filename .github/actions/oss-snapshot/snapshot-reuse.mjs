import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SNAPSHOT_IMAGES } from "./oss-snapshot-manifest.mjs";

// A component whose build inputs are unchanged since the previous complete
// staging snapshot reuses that snapshot's digest instead of rebuilding it. The
// inputs are everything BuildKit keys its layer cache on: the Dockerfile, every
// tracked file under each context path it copies or mounts that the ignore
// file lets into the build context, and the digests of the external images
// (frontend and bases) it pulls. Equal inputs are a full cache hit, so a
// rebuild would reproduce the same layers. Anything this parser cannot account
// for disables reuse for that component, and an ignore pattern it cannot
// evaluate exactly as Docker does excludes nothing: it never narrows inputs
// beyond what Docker itself leaves out.

export const INPUTS_LABEL = "pro.fabric.snapshot.inputs";
const INPUTS_SCHEMA = "fabric-snapshot-inputs/v2";
const PLATFORM = "linux/amd64";
// Every reuse adds two attestations to the reused digest, and admission reads
// all of them. Rebuilding daily bounds that growth and the age of the image.
export const MAX_REUSE_AGE_HOURS = 24;
const WORKFLOW = ".github/workflows/private-staging-images.yml";
const MODULE = ".github/actions/oss-snapshot/snapshot-reuse.mjs";
const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

class Unsupported extends Error {}

function unsupported(message) {
	throw new Unsupported(message);
}

function instructions(text) {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	let escapeCharacter = "\\";
	let syntax = null;
	let index = 0;
	for (; index < lines.length; index++) {
		const directive = lines[index].match(
			/^#\s*([a-zA-Z]+)\s*=\s*(\S+)\s*$/,
		);
		if (!directive) {
			break;
		}
		const name = directive[1].toLowerCase();
		if (name === "escape") {
			escapeCharacter = directive[2];
		} else if (name === "syntax") {
			syntax = directive[2];
		}
	}
	const result = [];
	let current = "";
	let heredocs = [];
	for (; index < lines.length; index++) {
		const line = lines[index];
		if (heredocs.length > 0) {
			const body = heredocs[0].strip ? line.replace(/^\t+/, "") : line;
			if (body === heredocs[0].word) {
				heredocs.shift();
			}
			continue;
		}
		if (/^\s*#/.test(line) || line.trim() === "") {
			continue;
		}
		const continued = line.trimEnd().endsWith(escapeCharacter);
		current += `${continued ? line.trimEnd().slice(0, -escapeCharacter.length) : line} `;
		if (continued) {
			continue;
		}
		const instruction = current.trim();
		current = "";
		heredocs = [
			...instruction.matchAll(/<<(-?)(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/g),
		].map((match) => ({ strip: match[1] === "-", word: match[3] }));
		result.push(instruction);
	}
	if (current.trim() !== "" || heredocs.length > 0) {
		unsupported("unterminated instruction");
	}
	return { syntax, instructions: result };
}

function words(args) {
	return args.trim().split(/\s+/).filter(Boolean);
}

// COPY and ADD accept a JSON array after their flags.
function copyArguments(args) {
	const flags = [];
	let rest = args.trim();
	for (
		let match = rest.match(/^(--\S+)\s*/);
		match;
		match = rest.match(/^(--\S+)\s*/)
	) {
		flags.push(match[1]);
		rest = rest.slice(match[0].length);
	}
	if (!rest.startsWith("[")) {
		return { flags, paths: words(rest) };
	}
	let paths;
	try {
		paths = JSON.parse(rest);
	} catch {
		unsupported(`malformed JSON-form arguments ${rest}`);
	}
	if (
		!Array.isArray(paths) ||
		paths.some((item) => typeof item !== "string")
	) {
		unsupported(`malformed JSON-form arguments ${rest}`);
	}
	return { flags, paths };
}

function contextPath(source) {
	if (/\$|^[a-z]+:\/\/|^git@|^:/i.test(source)) {
		unsupported(`unresolvable context source ${source}`);
	}
	const parts = source
		.split("/")
		.filter((part) => part !== "" && part !== ".");
	if (parts.includes("..")) {
		unsupported(`context source escapes the context: ${source}`);
	}
	return parts.length === 0 ? "." : parts.join("/");
}

function externalImage(reference) {
	if (reference.includes("$")) {
		unsupported(`unresolvable image ${reference}`);
	}
	return reference;
}

// Returns the external images and the context paths a Dockerfile reads.
export function parseDockerfile(text) {
	const parsed = instructions(text);
	const images = new Set(parsed.syntax ? [externalImage(parsed.syntax)] : []);
	const sources = new Set();
	const stages = [];
	const stageImage = (reference) => {
		const lowered = reference.toLowerCase();
		if (stages.includes(lowered) || /^[0-9]+$/.test(reference)) {
			return;
		}
		if (lowered !== "scratch") {
			images.add(externalImage(reference));
		}
	};
	for (const instruction of parsed.instructions) {
		const [, keyword = "", args = ""] =
			instruction.match(/^(\S+)\s*(.*)$/) ?? [];
		switch (keyword.toUpperCase()) {
			case "FROM": {
				const tokens = words(args).filter(
					(token) => !token.startsWith("--"),
				);
				if (
					tokens.length !== 1 &&
					!(tokens.length === 3 && tokens[1].toLowerCase() === "as")
				) {
					unsupported(`malformed FROM ${args}`);
				}
				stageImage(tokens[0]);
				stages.push((tokens[2] ?? String(stages.length)).toLowerCase());
				break;
			}
			case "COPY":
			case "ADD": {
				const { flags, paths } = copyArguments(args);
				if (paths.length < 2) {
					unsupported(`malformed ${keyword} ${args}`);
				}
				const from = flags.find((flag) => flag.startsWith("--from="));
				if (from) {
					stageImage(from.slice("--from=".length));
					break;
				}
				for (const source of paths.slice(0, -1)) {
					if (!source.startsWith("<<")) {
						sources.add(contextPath(source));
					}
				}
				break;
			}
			case "RUN": {
				const { flags } = copyArguments(args.replace(/\[.*$/s, ""));
				for (const flag of flags.filter((token) =>
					token.startsWith("--mount="),
				)) {
					const options = Object.fromEntries(
						flag
							.slice("--mount=".length)
							.split(",")
							.map((option) => {
								const separator = option.indexOf("=");
								return separator < 0
									? [option, ""]
									: [
											option.slice(0, separator),
											option.slice(separator + 1),
										];
							}),
					);
					if ((options.type ?? "bind") !== "bind") {
						continue;
					}
					if (options.from) {
						stageImage(options.from);
					} else {
						sources.add(
							contextPath(options.source ?? options.src ?? "."),
						);
					}
				}
				break;
			}
			case "ONBUILD":
				unsupported("ONBUILD triggers are not supported");
				break;
			default:
				break;
		}
	}
	return { images: [...images].sort(), sources: [...sources].sort() };
}

function sourcePattern(source) {
	if (source === ".") {
		return /^/;
	}
	// Docker's `*` stops at `/`; letting it match across directories only adds
	// inputs. A matched directory contributes everything beneath it.
	const pattern = source
		.split("")
		.map((character) => {
			if (character === "*") {
				return ".*";
			}
			if (character === "?") {
				return ".";
			}
			return /[\\^$.+(){}|]/.test(character)
				? `\\${character}`
				: character;
		})
		.join("");
	return new RegExp(`^${pattern}(/|$)`);
}

// Parses `git ls-tree -r -z --full-tree` output.
export function parseTree(output) {
	return output
		.split("\0")
		.filter(Boolean)
		.map((record) => {
			const match = record.match(
				/^([0-7]{6}) (\w+) ([0-9a-f]{40,64})\t(.+)$/s,
			);
			if (!match) {
				throw new Error(
					`unexpected tree record ${JSON.stringify(record)}`,
				);
			}
			return {
				mode: match[1],
				type: match[2],
				object: match[3],
				path: match[4],
			};
		});
}

// One ignore-file pattern as a test of a context path, matching exactly when
// moby/patternmatcher (BuildKit's context filter) matches the path or one of
// its parent directories. Character classes, escapes, `^` (which that matcher
// passes to its regular expression unescaped), `..` and `**` inside a path
// segment are not evaluated: they return null.
function ignorePattern(pattern) {
	const segments = pattern
		.split("/")
		.filter((segment) => segment !== "" && segment !== ".");
	if (
		segments.length === 0 ||
		segments.some(
			(segment) =>
				segment === ".." ||
				/[[\]\\^]/.test(segment) ||
				(segment !== "**" && segment.includes("**")),
		)
	) {
		return null;
	}
	const source = segments
		.map((segment, index) => {
			const last = index === segments.length - 1;
			if (segment === "**") {
				return last ? ".*" : "(.*/)?";
			}
			const glob = segment
				.split("")
				.map((character) => {
					if (character === "*") {
						return "[^/]*";
					}
					if (character === "?") {
						return "[^/]";
					}
					return /[.+()|{}$]/.test(character)
						? `\\${character}`
						: character;
				})
				.join("");
			return last ? glob : `${glob}/`;
		})
		.join("");
	const regex = new RegExp(`^${source}$`);
	return (path) => {
		const parts = path.split("/");
		return parts.some((_, index) =>
			regex.test(parts.slice(0, index + 1).join("/")),
		);
	};
}

// Whether a .dockerignore keeps a path out of the build context. Lines are
// read as moby/patternmatcher/ignorefile reads them. A path counts as excluded
// only when an exclusion matches it and no exception (`!pattern`) can match
// it, so an exception keeps its path even where a later line would exclude it
// again; an exception this module cannot evaluate keeps every path.
export function dockerignore(text) {
	const exclusions = [];
	const exceptions = [];
	let opaque = false;
	const withoutMark = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	for (const line of withoutMark.split("\n")) {
		if (line.startsWith("#")) {
			continue;
		}
		let pattern = line.trim();
		if (pattern === "") {
			continue;
		}
		const exception = pattern.startsWith("!");
		if (exception) {
			pattern = pattern.slice(1).trim();
		}
		const matches = ignorePattern(pattern);
		if (exception) {
			if (matches) {
				exceptions.push(matches);
			} else {
				opaque = true;
			}
		} else if (matches) {
			exclusions.push(matches);
		}
	}
	return (path) =>
		!opaque &&
		exclusions.some((matches) => matches(path)) &&
		!exceptions.some((matches) => matches(path));
}

// BuildKit reads `<Dockerfile>.dockerignore` when it exists and the context's
// `.dockerignore` otherwise. A path is excluded only when every ignore file
// that exists excludes it, so the choice between them never matters here.
function contextIgnore(tree, dockerfile, readBlob) {
	const ignoreFiles = tree.filter(
		(entry) =>
			entry.path === `${dockerfile}.dockerignore` ||
			entry.path === ".dockerignore",
	);
	if (
		ignoreFiles.length === 0 ||
		ignoreFiles.some(
			(entry) =>
				entry.type !== "blob" ||
				(entry.mode !== "100644" && entry.mode !== "100755"),
		)
	) {
		return () => false;
	}
	const excluders = ignoreFiles.map((entry) =>
		dockerignore(readBlob(entry.path)),
	);
	return (path) => excluders.every((excluded) => excluded(path));
}

export function inputFiles(tree, dockerfile, sources, ignored = () => false) {
	const patterns = sources.map(sourcePattern);
	const named = new Set([
		dockerfile,
		`${dockerfile}.dockerignore`,
		".dockerignore",
		WORKFLOW,
		MODULE,
	]);
	const files = tree.filter(
		(entry) =>
			named.has(entry.path) ||
			(patterns.some((pattern) => pattern.test(entry.path)) &&
				!ignored(entry.path)),
	);
	for (const entry of files) {
		if (entry.type !== "blob") {
			unsupported(`${entry.path} is a ${entry.type}`);
		}
		if (entry.mode === "120000" && sources.includes(entry.path)) {
			unsupported(`context source ${entry.path} is a symbolic link`);
		}
	}
	if (!files.some((entry) => entry.path === dockerfile)) {
		unsupported(`${dockerfile} is not in the source tree`);
	}
	return files.sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
	);
}

export function fingerprint({ dockerfile, files, images }) {
	const canonical = JSON.stringify({
		schema: INPUTS_SCHEMA,
		dockerfile,
		context: ".",
		platform: PLATFORM,
		files: files.map(({ path, mode, object }) => [path, mode, object]),
		images: Object.entries(images).sort(([a], [b]) =>
			a < b ? -1 : a > b ? 1 : 0,
		),
	});
	return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

// The inputs of every snapshot component at one commit, or a reason the
// component must be rebuilt. `resolved` maps each external image to the digest
// it resolves to now; an image missing from it disables reuse.
export function componentInputs(tree, readBlob, resolved) {
	return SNAPSHOT_IMAGES.map(({ component, dockerfile }) => {
		try {
			const parsed = parseDockerfile(readBlob(dockerfile));
			const images = {};
			for (const image of parsed.images) {
				if (!DIGEST_RE.test(resolved[image] ?? "")) {
					unsupported(`${image} did not resolve to a digest`);
				}
				images[image] = resolved[image];
			}
			const files = inputFiles(
				tree,
				dockerfile,
				parsed.sources,
				contextIgnore(tree, dockerfile, readBlob),
			);
			return {
				component,
				dockerfile,
				inputs: fingerprint({ dockerfile, files, images }),
			};
		} catch (error) {
			if (!(error instanceof Unsupported)) {
				throw error;
			}
			return { component, dockerfile, inputs: "", reason: error.message };
		}
	});
}

// `previous` describes the newest complete staging snapshot: its source SHA
// and run, and per component the digest its full-SHA tag resolved to with that
// image's labels and creation time.
export function planSnapshots(
	components,
	previous,
	now,
	maxAgeHours = MAX_REUSE_AGE_HOURS,
) {
	const build = [];
	const reuse = [];
	for (const entry of components) {
		const image = previous?.images?.[entry.component];
		const created = Date.parse(image?.created ?? "");
		const ageHours = (now - created) / 3_600_000;
		let reason = entry.reason ?? "";
		if (!reason && !DIGEST_RE.test(entry.inputs ?? "")) {
			reason = "inputs are unknown";
		} else if (
			!reason &&
			!(
				SHA_RE.test(previous?.sourceSha ?? "") &&
				/^[1-9][0-9]*$/.test(String(previous?.run ?? ""))
			)
		) {
			reason = "no previous complete staging snapshot";
		} else if (!reason && !image) {
			reason = "previous snapshot image not found";
		} else if (!reason && !DIGEST_RE.test(image.digest ?? "")) {
			reason = "previous snapshot digest is malformed";
		} else if (!reason && image.labels?.[INPUTS_LABEL] !== entry.inputs) {
			reason = "inputs changed";
		} else if (
			!reason &&
			!SHA_RE.test(
				image.labels?.["org.opencontainers.image.revision"] ?? "",
			)
		) {
			reason = "previous snapshot has no revision label";
		} else if (!reason && !(ageHours > -1 && ageHours < maxAgeHours)) {
			reason = `previous image was not built within the last ${maxAgeHours} hours`;
		}
		if (reason) {
			build.push({
				component: entry.component,
				dockerfile: entry.dockerfile,
				inputs: entry.inputs,
				reason,
			});
			continue;
		}
		reuse.push({
			component: entry.component,
			dockerfile: entry.dockerfile,
			inputs: entry.inputs,
			digest: image.digest,
			reusedSourceSha: previous.sourceSha,
			reusedRun: String(previous.run),
			builtSourceSha: image.labels["org.opencontainers.image.revision"],
		});
	}
	return { build, reuse };
}

// Promotion and manual recovery builds rebuild every component exactly as
// before reuse existed: no fingerprint, so no inputs label on their images.
export function rebuildEverything() {
	return {
		build: SNAPSHOT_IMAGES.map(({ component, dockerfile }) => ({
			component,
			dockerfile,
			inputs: "",
			reason: "reuse applies only to automatic staging pushes",
		})),
		reuse: [],
	};
}

// SLSA v1 provenance for a reused digest. It has the shape GitHub's
// build-provenance generator produces for this run, and names the reused
// snapshot as a resolved dependency so the record says the bytes were not
// rebuilt here.
export function reuseProvenance(context, reused) {
	for (const field of ["sha", "reusedSourceSha", "builtSourceSha"]) {
		const value = field === "sha" ? context.sha : reused[field];
		if (!SHA_RE.test(value ?? "")) {
			throw new Error(`${field} must be a full commit SHA`);
		}
	}
	if (
		!DIGEST_RE.test(reused.digest ?? "") ||
		!DIGEST_RE.test(reused.inputs ?? "")
	) {
		throw new Error("reused digest and inputs must be sha256 digests");
	}
	const repositoryUrl = `${context.serverUrl}/${context.repository}`;
	return {
		buildDefinition: {
			buildType: "https://actions.github.io/buildtypes/workflow/v1",
			externalParameters: {
				workflow: {
					ref: context.ref,
					repository: repositoryUrl,
					path: context.workflowPath,
				},
			},
			internalParameters: {
				github: {
					event_name: context.eventName,
					repository_id: context.repositoryId,
					repository_owner_id: context.repositoryOwnerId,
					runner_environment: context.runnerEnvironment,
				},
			},
			resolvedDependencies: [
				{
					uri: `git+${repositoryUrl}@${context.ref}`,
					digest: { gitCommit: context.sha },
				},
				{
					uri: `oci://${reused.image}`,
					digest: { sha256: reused.digest.slice("sha256:".length) },
					annotations: {
						reusedFromSourceSha: reused.reusedSourceSha,
						reusedFromRun: `${repositoryUrl}/actions/runs/${reused.reusedRun}`,
						builtFromSourceSha: reused.builtSourceSha,
						inputs: reused.inputs,
					},
				},
			],
		},
		runDetails: {
			builder: { id: `${context.serverUrl}/${context.workflowRef}` },
			metadata: {
				invocationId: `${repositoryUrl}/actions/runs/${context.runId}/attempts/${context.runAttempt}`,
			},
		},
	};
}

function git(...args) {
	return execFileSync("git", args, {
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
	});
}

function readArgs(argv) {
	const args = new Map();
	for (let index = 0; index < argv.length; index += 2) {
		if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined) {
			throw new Error(
				`invalid argument near ${argv[index] ?? "end of input"}`,
			);
		}
		args.set(argv[index].slice(2), argv[index + 1]);
	}
	return args;
}

function required(args, key) {
	const value = args.get(key);
	if (value === undefined) {
		throw new Error(`missing --${key}`);
	}
	return value;
}

function sourceTree(sha) {
	if (!SHA_RE.test(sha)) {
		throw new Error("--sha must be a full commit SHA");
	}
	return {
		tree: parseTree(git("ls-tree", "-r", "-z", "--full-tree", sha)),
		readBlob: (path) => git("cat-file", "blob", `${sha}:${path}`),
	};
}

function main([command, ...rest]) {
	const args = readArgs(rest);
	switch (command) {
		case "components":
			return `${SNAPSHOT_IMAGES.map(({ component }) => component).join("\n")}\n`;
		case "images": {
			// External images every component pulls, for the caller to resolve.
			const { readBlob } = sourceTree(required(args, "sha"));
			const images = new Set();
			for (const { dockerfile } of SNAPSHOT_IMAGES) {
				try {
					for (const image of parseDockerfile(readBlob(dockerfile))
						.images) {
						images.add(image);
					}
				} catch (error) {
					if (!(error instanceof Unsupported)) {
						throw error;
					}
				}
			}
			return `${[...images].sort().join("\n")}\n`;
		}
		case "plan": {
			if (required(args, "reuse") !== "true") {
				return `${JSON.stringify(rebuildEverything())}\n`;
			}
			const { tree, readBlob } = sourceTree(required(args, "sha"));
			const resolved = JSON.parse(
				readFileSync(required(args, "images"), "utf8"),
			);
			const previous = JSON.parse(
				readFileSync(required(args, "previous"), "utf8"),
			);
			return `${JSON.stringify(planSnapshots(componentInputs(tree, readBlob, resolved), previous, Date.now()))}\n`;
		}
		case "provenance": {
			const env = process.env;
			return `${JSON.stringify(
				reuseProvenance(
					{
						serverUrl: env.GITHUB_SERVER_URL,
						repository: env.GITHUB_REPOSITORY,
						ref: env.GITHUB_REF,
						sha: env.GITHUB_SHA,
						workflowPath: WORKFLOW,
						workflowRef: env.GITHUB_WORKFLOW_REF,
						runId: env.GITHUB_RUN_ID,
						runAttempt: env.GITHUB_RUN_ATTEMPT,
						eventName: env.GITHUB_EVENT_NAME,
						repositoryId: env.GITHUB_REPOSITORY_ID,
						repositoryOwnerId: env.GITHUB_REPOSITORY_OWNER_ID,
						runnerEnvironment: env.RUNNER_ENVIRONMENT,
					},
					JSON.parse(required(args, "reused")),
				),
			)}\n`;
		}
		default:
			throw new Error(
				"usage: snapshot-reuse.mjs components|images|plan|provenance",
			);
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		process.stdout.write(main(process.argv.slice(2)));
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
