// @vitest-environment node
/**
 * The deployment can only serve the CLI if every build that produces the web
 * app packs it first.
 *
 * Three builds exist: Vercel (`turbo build`), the Docker image (which calls
 * `next build` itself), and a developer's machine. A build that skips the pack
 * step still succeeds, and ships a Connect dialog that says the deployment
 * serves no CLI, so the wiring is asserted here rather than discovered on a
 * running deployment.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../../..");

function read(relative: string): string {
	return readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

/** `turbo.json` allows whole-line comments, which `JSON.parse` does not. */
function readTurbo(): {
	globalEnv: string[];
	tasks: Record<
		string,
		{ dependsOn?: string[]; outputs?: string[]; env?: string[] }
	>;
} {
	const withoutComments = read("turbo.json")
		.split("\n")
		.filter((line) => !line.trim().startsWith("//"))
		.join("\n");
	return JSON.parse(withoutComments);
}

const PACK_TASK = "@fabricorg/cli#pack:deployment";

describe("serving the CLI from the deployment", () => {
	it("makes the web build wait for the pack step, in its own task", () => {
		const { tasks } = readTurbo();

		expect(tasks["@repo/web#build"]?.dependsOn).toContain(PACK_TASK);
		expect(tasks[PACK_TASK]).toBeDefined();
		expect(tasks[PACK_TASK]?.outputs).toContain(
			"$TURBO_ROOT$/apps/web/public/cli/**",
		);
	});

	// A tarball can have its build's address baked in. A cache hit from a build
	// with another address would serve a CLI that signs in somewhere else, so
	// every variable the address is read from has to be in the task's hash:
	// the one the pack step reads that turbo only passes through is listed as
	// the task's own `env`, the other two are in `globalEnv` already. What
	// Vercel supplies is not read (a preview's address is a per-deployment host,
	// and the production domain would be baked into a staging build), so it is
	// not hashed either.
	it("hashes every variable the baked address is read from, and none that Vercel supplies", () => {
		const { globalEnv, tasks } = readTurbo();

		expect(tasks[PACK_TASK]?.env).toEqual(["FABRIC_CLI_ORIGIN"]);
		expect(globalEnv).toContain("NEXT_PUBLIC_*");
		expect(globalEnv).toContain("APP_URL");
		expect(JSON.stringify(tasks[PACK_TASK])).not.toContain("VERCEL");
	});

	it("lets a Docker build say which address to bake in", () => {
		const dockerfile = read("apps/web/Dockerfile");
		const argument = dockerfile.indexOf("ARG FABRIC_CLI_ORIGIN");
		const pack = dockerfile.indexOf(
			"pnpm --filter @fabricorg/cli pack:deployment",
		);

		expect(argument).toBeGreaterThan(-1);
		expect(argument).toBeLessThan(pack);
	});

	it("keeps the web build's own outputs when it names its own task", () => {
		// A package-specific task replaces the generic `build` definition
		// entirely, so dropping the outputs here would stop `.next` being cached.
		const { tasks } = readTurbo();

		expect(tasks["@repo/web#build"]?.outputs).toEqual(tasks.build?.outputs);
	});

	it("lists the CLI as a web dependency so a filtered install reaches it", () => {
		const web = JSON.parse(read("apps/web/package.json")) as {
			devDependencies: Record<string, string>;
		};

		expect(web.devDependencies["@fabricorg/cli"]).toBe("workspace:*");
	});

	it("exposes the pack step as a script of the CLI package", () => {
		const cli = JSON.parse(read("packages/cli/package.json")) as {
			scripts: Record<string, string>;
		};

		expect(cli.scripts["pack:deployment"]).toBe(
			"node scripts/pack-deployment.mjs",
		);
	});

	it("packs inside the Docker build before `next build` starts", () => {
		const dockerfile = read("apps/web/Dockerfile");
		const pack = dockerfile.indexOf(
			"pnpm --filter @fabricorg/cli pack:deployment",
		);
		const nextBuild = dockerfile.indexOf("next/dist/bin/next build");

		expect(pack).toBeGreaterThan(-1);
		expect(nextBuild).toBeGreaterThan(pack);
	});

	it("ignores what the pack step generates", () => {
		expect(read("apps/web/.gitignore")).toContain("/public/cli/");
		expect(read("packages/cli/.gitignore")).toContain("/dist-bundle/");
	});
});
