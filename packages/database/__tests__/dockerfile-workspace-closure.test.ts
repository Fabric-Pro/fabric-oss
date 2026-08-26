import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every image that installs from the workspace enumerates the package manifests
 * it copies before running `pnpm install`. Miss one and pnpm never links it, so
 * the build fails resolving that package's own dependencies — far from the
 * Dockerfile, and only in Docker.
 *
 * This has broken two images silently. `@repo/databricks` became a dependency of
 * `@repo/database` and only the temporal Dockerfile's list was updated: the
 * migration runner and the web image both stopped building, and nothing noticed
 * because nothing built them. The web image failed with 23 module-resolution
 * errors, 89 references deep in `packages/atlas`, whose manifest was also absent.
 *
 * So the rule is checked here rather than left to whoever edits a package.json:
 * for each image, the transitive workspace closure of its entry package must be
 * a subset of what its Dockerfile copies.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Images that COMPILE the workspace during the build. A manifest missing here is
 * a hard build failure, so the closure must be complete.
 */
const COMPILING: ReadonlyArray<{ dockerfile: string; entry: string }> = [
	{ dockerfile: "apps/web/Dockerfile", entry: "apps/web/package.json" },
	{
		dockerfile: "packages/database/Dockerfile.migrate",
		entry: "packages/database/package.json",
	},
];

/**
 * Images that only run `tsx` at runtime and compile nothing at build time. A
 * missing manifest does not break their build, and both build green today, so
 * requiring a complete closure would fail a working image.
 *
 * Their gaps are pinned instead of ignored: the set may shrink, never grow. Each
 * one is a latent runtime resolution failure waiting for a code path that reaches
 * it, so this is a record of debt rather than a blessing.
 */
const RUNTIME_ONLY: ReadonlyArray<{
	dockerfile: string;
	entry: string;
	knownGaps: readonly string[];
}> = [
	{
		dockerfile: "packages/temporal/Dockerfile",
		entry: "packages/temporal/package.json",
		knownGaps: ["permissions"],
	},
	{
		dockerfile: "packages/mcp-stdio-wrapper/Dockerfile",
		entry: "packages/mcp-stdio-wrapper/package.json",
		// All five former gaps were reached only through @repo/database and
		// @repo/utils, which were unused and removed from this package. The
		// closure is now fully copied; the pin stays so it can never regrow.
		knownGaps: [],
	},
];

/**
 * The langchain agents, which had no coverage here at all until 2026-08-19.
 *
 * They bundle with tsup at build time, so an unresolvable workspace package is
 * a hard build failure — the same tier as COMPILING. Their closures are not
 * complete today though, and most build green regardless, because a missing
 * manifest only bites once code actually reaches that package. So the gaps are
 * pinned, exactly as RUNTIME_ONLY's are: the list may shrink, never grow.
 *
 * What this catches: a new `@repo/*` dependency added to an agent's manifest
 * without its Dockerfile being updated. That is the original failure this file
 * was written for.
 *
 * What it does NOT catch, and the reason weave-planners broke on 2026-08-19:
 * `openapi-tools` was already an uncopied gap, and stayed one — what changed is
 * that #2910 gave the agent a code path that reached it, turning a dormant gap
 * into `Could not resolve "js-yaml"` at bundle time, in a deploy, hours after
 * merge. No manifest changed, so no gap list would have moved. Only building
 * the image catches that, and nothing builds these on a pull request.
 */
/**
 * Recorded 2026-08-19. Absent names have a complete closure: `weave-planners`
 * because its three gaps were closed in the same change — which is what a
 * shrinking list looks like — and `custom-agent-runtime` and `weave-shuttle`
 * because they barely depend on the workspace at all.
 */
const AGENT_GAPS: Record<string, readonly string[]> = {
	"api-agent": [
		"agent-prompts",
		"integrations",
		"openapi-tools",
		"payments",
		"permissions",
		"storage",
	],
	"backlog-updater": [
		"integrations",
		"openapi-tools",
		"payments",
		"permissions",
		"storage",
	],
	"data-analyst": [
		"agent-prompts",
		"integrations",
		"openapi-tools",
		"payments",
		"permissions",
		"storage",
	],
	"document-generator": [
		"integrations",
		"openapi-tools",
		"payments",
		"permissions",
		"storage",
	],
	"project-document-generator": [
		"integrations",
		"openapi-tools",
		"payments",
		"permissions",
		"storage",
	],
	"prompt-enhancer": [
		"agent-prompts",
		"integrations",
		"openapi-tools",
		"payments",
		"permissions",
		"storage",
	],
	"story-breakdown": [
		"agent-prompts",
		"integrations",
		"openapi-tools",
		"payments",
		"permissions",
		"storage",
	],
	"task-planner": [
		"agent-prompts",
		"integrations",
		"openapi-tools",
		"payments",
		"permissions",
		"storage",
	],
	"weave-readers": ["agent-prompts", "permissions"],
};

const AGENTS: ReadonlyArray<{
	dockerfile: string;
	entry: string;
	knownGaps: readonly string[];
}> = [
	"api-agent",
	"backlog-updater",
	"custom-agent-runtime",
	"data-analyst",
	"document-generator",
	"project-document-generator",
	"prompt-enhancer",
	"story-breakdown",
	"task-planner",
	"weave-planners",
	"weave-readers",
	"weave-shuttle",
].map((name) => ({
	dockerfile: `agents/langchain/${name}/Dockerfile`,
	entry: `agents/langchain/${name}/package.json`,
	knownGaps: AGENT_GAPS[name] ?? [],
}));

function workspaceDeps(manifestPath: string): Set<string> {
	const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};
	const names = new Set<string>();
	for (const section of [manifest.dependencies, manifest.devDependencies]) {
		for (const [name, range] of Object.entries(section ?? {})) {
			if (range.startsWith("workspace:") && name.startsWith("@repo/")) {
				names.add(name.slice("@repo/".length));
			}
		}
	}
	return names;
}

/** Transitive workspace closure, restricted to packages that live in packages/. */
function closureOf(entry: string): Set<string> {
	const seen = new Set<string>();
	const stack = [...workspaceDeps(join(REPO, entry))];

	while (stack.length > 0) {
		const name = stack.pop() as string;
		if (seen.has(name)) {
			continue;
		}
		seen.add(name);
		const manifest = join(REPO, "packages", name, "package.json");
		if (existsSync(manifest)) {
			stack.push(...workspaceDeps(manifest));
		}
	}

	// @repo/tsconfig and friends live outside packages/ and are copied wholesale.
	return new Set(
		[...seen].filter((name) => existsSync(join(REPO, "packages", name))),
	);
}

function copiedBy(dockerfile: string): Set<string> {
	const text = readFileSync(join(REPO, dockerfile), "utf-8");
	return new Set(
		[...text.matchAll(/packages\/([a-z0-9-]+)\/package\.json/g)].map(
			(match) => match[1],
		),
	);
}

function missingFrom(dockerfile: string, entry: string): string[] {
	const copied = copiedBy(dockerfile);
	return [...closureOf(entry)].filter((name) => !copied.has(name)).sort();
}

describe.each(COMPILING)(
	"$dockerfile compiles the workspace, so its closure must be complete",
	({ dockerfile, entry }) => {
		it("copies a manifest for every workspace package it transitively needs", () => {
			const missing = missingFrom(dockerfile, entry);
			expect(
				missing,
				`${dockerfile} does not COPY package.json for: ${missing.join(", ")}. ` +
					"pnpm will not link them, and the build fails resolving their own dependencies.",
			).toEqual([]);
		});
	},
);

describe.each(AGENTS)(
	"$dockerfile bundles at build time, so its gaps are pinned",
	({ dockerfile, entry, knownGaps }) => {
		it("has not grown a new gap", () => {
			const missing = missingFrom(dockerfile, entry);
			const newGaps = missing.filter((name) => !knownGaps.includes(name));
			expect(
				newGaps,
				`${dockerfile} gained a workspace dependency it does not COPY: ${newGaps.join(", ")}. ` +
					"tsup cannot resolve it, and the image fails to build — in a deploy, not on the pull request.",
			).toEqual([]);
		});

		it("still has the gaps recorded, so a fixed one gets removed from the list", () => {
			expect(missingFrom(dockerfile, entry)).toEqual([...knownGaps]);
		});
	},
);

describe.each(RUNTIME_ONLY)(
	"$dockerfile resolves at runtime, so its gaps are pinned",
	({ dockerfile, entry, knownGaps }) => {
		it("has not grown a new gap", () => {
			const missing = missingFrom(dockerfile, entry);
			const newGaps = missing.filter((name) => !knownGaps.includes(name));
			expect(
				newGaps,
				`${dockerfile} gained a workspace dependency it does not COPY: ${newGaps.join(", ")}. ` +
					"It will not break the build, but it will fail to resolve at runtime.",
			).toEqual([]);
		});

		it("still has the gaps recorded, so a fixed one gets removed from the list", () => {
			expect(missingFrom(dockerfile, entry)).toEqual([...knownGaps]);
		});
	},
);
