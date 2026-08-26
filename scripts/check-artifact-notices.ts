/**
 * CI gate: the container images and npm packages we hand to someone else carry
 * the licence and the attribution notices that come with it.
 *
 * Those two are what a release produces today. A web or collaboration-server
 * build artifact would fall under the same rule, but nothing attaches one to a
 * release yet — add it here when something does. SBOMs and build attestations
 * are deliberately outside the rule: they describe an artifact rather than
 * carry a copy of the Work. docs/licensing.md records both boundaries.
 *
 * Apache-2.0 §4(a) obliges us to give every recipient of a distributed artifact
 * a copy of the License, and §4(d) obliges the NOTICE attributions to travel
 * with it. MIT's condition is the same shape. A source tree satisfies both by
 * having the files at its root; a container image or an npm tarball does not,
 * because the recipient never sees the tree — they see whatever the build put
 * inside the artifact. So the obligation has to be checked where the artifact
 * is assembled.
 *
 * This exists because four Dockerfiles copied the three files and sixteen did
 * not, with nothing to say which was correct. The plan that commits us to
 * publishing every image to GHCR (the open-sourcing plan)
 * would have turned each of those omissions into a licensing defect on the day
 * the image went public, discovered by whoever pulled it.
 *
 * Two rules, both defaulting to "must carry the notices" so a new artifact is
 * covered without anyone remembering to add it here:
 *
 *   Images  — every Dockerfile must COPY the three root notice files, unless it
 *             is named in NOT_DISTRIBUTED below with a reason.
 *   Packages — every publishable manifest must sit beside a LICENSE, and any
 *             notice file npm does not include by itself must be named in
 *             `files`.
 *
 * See docs/licensing.md for the rule this enforces.
 */
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The three files the root ships and every distributed artifact must carry. */
const NOTICE_FILES = ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"] as const;

/**
 * Images we do not publish. Each builds from a narrow context that cannot reach
 * the root LICENSE, and each is either run by us or built by the operator from
 * this repository — where the root files already satisfy the obligation.
 *
 * The list may shrink, never grow. An entry here is a claim that nobody pulls
 * this image from us; publishing one moves it out of the list rather than
 * widening the list to fit.
 */
const NOT_DISTRIBUTED: ReadonlyArray<{ dockerfile: string; why: string }> = [
	{
		dockerfile: "party-cf/Dockerfile",
		why: "Self-host convenience. deploy/helm/fabric/values.yaml tells the operator to build it and push to their own registry; we deploy PartyKit to Cloudflare with `wrangler deploy` and publish no image.",
	},
	{
		dockerfile: "services/sandbox-worker/Dockerfile",
		why: "Built by Cloudflare at `wrangler deploy` and run as a service. Nothing pulls it, so nothing is distributed.",
	},
	{
		dockerfile: "packages/evidence/docker/Dockerfile",
		why: "Local builder image for Evidence.dev projects, built on a developer machine and never pushed.",
	},
	{
		dockerfile: "monitoring/otel-collector/Dockerfile",
		why: "Local dev observability. Upstream collector plus our config file, built by compose and never pushed.",
	},
];

/**
 * npm publishes these regardless of `files`, so they need no declaration —
 * npm-packlist's always-include glob is `license{,.*[^~$]}`. Anything else in
 * the notice family does need declaring: `LICENSE-APACHE-2.0` is outside this
 * pattern, which is why the packages carrying Corsair-derived material name it
 * explicitly.
 */
const NPM_ALWAYS_PACKS = /^licen[cs]e(\.[^~$]*)?$/i;
const NOTICE_FAMILY = /^(licen[cs]e|notice|third[-_]party[-_]notices)/i;

/** Directories that hold nothing we build or publish. */
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	".next",
	".turbo",
	"dist",
	"build",
	".claude",
	".Codex",
]);

const dockerfiles: string[] = [];
const manifests: string[] = [];

function walk(dir: string) {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (SKIP_DIRS.has(entry.name)) {
			continue;
		}
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			walk(full);
		} else if (
			entry.name === "Dockerfile" ||
			entry.name.startsWith("Dockerfile.")
		) {
			dockerfiles.push(full);
		} else if (entry.name === "package.json") {
			manifests.push(full);
		}
	}
}

walk(REPO);
dockerfiles.sort();
manifests.sort();

/**
 * The source paths a Dockerfile's final stage copies in.
 *
 * Two things this deliberately does not do naively. Only the final stage is
 * read, because copying the notices into a builder stage the runtime never
 * inherits from would satisfy a substring search and still ship a bare image.
 * And a source has to be the *whole* path token, so an unrelated
 * `COPY --from=builder /app/node_modules/some-dep/LICENSE ./vendor/` — a third
 * party's licence, landing somewhere else — does not pass for ours.
 *
 * The exec form is what every Dockerfile here uses; the JSON-array form would
 * read as no sources at all and fail loudly, which is the safe direction.
 */
function copiedInFinalStage(contents: string): Set<string> {
	const stages = contents.split(/^FROM /im);
	const sources = new Set<string>();
	for (const line of stages[stages.length - 1].split("\n")) {
		const tokens = line.trim().split(/\s+/);
		if (tokens[0] !== "COPY") {
			continue;
		}
		// Drop the verb, its flags, and the destination — what is left is sources.
		for (const token of tokens.slice(1, -1)) {
			if (!token.startsWith("--")) {
				sources.add(token);
			}
		}
	}
	return sources;
}

const failures: string[] = [];

// --- The root itself -------------------------------------------------------
for (const file of NOTICE_FILES) {
	if (!existsSync(join(REPO, file))) {
		failures.push(
			`${file} is missing from the repository root. Every image copies it and NOTICE points at THIRD_PARTY_NOTICES.md.`,
		);
	}
}

// --- Container images ------------------------------------------------------
const exempt = new Set(NOT_DISTRIBUTED.map((e) => e.dockerfile));

for (const path of dockerfiles) {
	const rel = path.slice(REPO.length + 1).replace(/\\/g, "/");
	if (exempt.has(rel)) {
		continue;
	}
	const copied = copiedInFinalStage(readFileSync(path, "utf-8"));
	const missing = NOTICE_FILES.filter((file) => !copied.has(file));
	if (missing.length > 0) {
		failures.push(
			`${rel} does not copy ${missing.join(", ")} into the image.\n` +
				"    Add, in the final stage while WORKDIR is still the app root:\n" +
				"      COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md ./\n" +
				"    If nobody pulls this image from us, add it to NOT_DISTRIBUTED in this script with the reason.",
		);
	}
}

for (const { dockerfile } of NOT_DISTRIBUTED) {
	if (!existsSync(join(REPO, dockerfile))) {
		failures.push(
			`NOT_DISTRIBUTED names ${dockerfile}, which no longer exists. Drop the entry — the list is a record of live exemptions, not history.`,
		);
	}
}

// --- npm packages ----------------------------------------------------------
let publishable = 0;

for (const path of manifests) {
	const rel = path.slice(REPO.length + 1).replace(/\\/g, "/");
	const manifest = JSON.parse(readFileSync(path, "utf-8")) as {
		private?: boolean;
		files?: string[];
	};
	// Workspace-internal packages, and the root manifest, are never published —
	// their only recipient is this repository.
	if (manifest.private === true) {
		continue;
	}
	publishable++;
	const dir = dirname(path);
	if (!existsSync(join(dir, "LICENSE"))) {
		failures.push(
			`${rel} is publishable but has no LICENSE beside it. npm packs LICENSE into every tarball; without the file there is nothing to pack.`,
		);
	}
	if (!manifest.files) {
		continue;
	}
	const undeclared = readdirSync(dir).filter(
		(name) =>
			NOTICE_FAMILY.test(name) &&
			!NPM_ALWAYS_PACKS.test(name) &&
			!manifest.files?.includes(name),
	);
	if (undeclared.length > 0) {
		failures.push(
			`${rel} has a \`files\` array that omits ${undeclared.join(", ")}.\n` +
				"    npm packs only what `files` names plus package.json, README and LICENSE, so these never reach the tarball.",
		);
	}
}

// --- Report ----------------------------------------------------------------
if (failures.length > 0) {
	console.error(
		"[artifact-notices] FAIL — a distributed artifact would ship without its licence or attribution notices:\n",
	);
	for (const failure of failures) {
		console.error(`  ${failure}\n`);
	}
	console.error("See docs/licensing.md for what obliges this.");
	process.exit(1);
}

console.log(
	`[artifact-notices] PASS — ${dockerfiles.length - NOT_DISTRIBUTED.length} images and ${publishable} publishable packages carry their licence and notices (${NOT_DISTRIBUTED.length} images exempt).`,
);
