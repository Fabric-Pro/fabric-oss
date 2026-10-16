/**
 * The memory mirror works only inside the folder `fabric instructions init`
 * set up, and only in the git repository `init` recorded there.
 *
 * It writes files and edits `.git/info/exclude`, so a session started in a
 * subfolder of an unrelated checkout must neither write into that checkout nor
 * touch its git directory. These tests start a runtime from real folders and
 * real repositories and look at what was and was not written.
 */
import { execFileSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	findProjectRoot,
	writeProjectMarker,
} from "../src/lib/memory/project-root.js";
import { pull } from "../src/lib/memory/pull.js";
import { push } from "../src/lib/memory/push.js";
import { createRuntime } from "../src/lib/memory/runtime.js";
import { FakeMemoryServer } from "./helpers/fake-memory.js";

const { mocks } = vi.hoisted(() => ({
	mocks: { memory: undefined as unknown },
}));

vi.mock("../src/lib/config.js", () => ({
	getApiKey: () => "example-key",
	getBaseUrl: () => undefined,
}));

vi.mock("../src/lib/client.js", () => ({
	getClient: () => {
		const client = {
			memory: mocks.memory,
			withoutContext: () => client,
		};
		return client;
	},
}));

const PROJECT = "cmexampleproject0123456789";

let directory: string;
let server: FakeMemoryServer;

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function folder(...segments: string[]): Promise<string> {
	const made = path.join(directory, ...segments);
	await mkdir(made, { recursive: true });
	return made;
}

async function exists(file: string): Promise<boolean> {
	return stat(file).then(
		() => true,
		() => false,
	);
}

async function exclude(repository: string): Promise<string> {
	return readFile(
		path.join(repository, ".git", "info", "exclude"),
		"utf8",
	).catch(() => "");
}

beforeEach(async () => {
	directory = await realpath(
		await mkdtemp(path.join(tmpdir(), "fabric-boundary-")),
	);
	server = new FakeMemoryServer();
	mocks.memory = server.memory;
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe("the project folder", () => {
	it("is the nearest folder above the working directory that init marked", async () => {
		const project = await folder("project");
		const nested = await folder("project", "src", "deep");
		await writeProjectMarker(project, {
			projectId: PROJECT,
			gitToplevel: null,
		});

		const found = await findProjectRoot(nested);

		expect(found?.root).toBe(project);
		expect(found?.marker.projectId).toBe(PROJECT);
	});

	it("works from a subfolder, mirroring under the marked folder", async () => {
		const project = await folder("project");
		const nested = await folder("project", "src");
		server.set("docs/ai/spec.md", "# Spec\n");
		await writeProjectMarker(project, {
			projectId: PROJECT,
			gitToplevel: null,
		});

		const { context } = await createRuntime({ dest: nested });
		await pull(context);

		expect(context.root).toBe(project);
		expect(
			await readFile(path.join(project, "docs/ai/spec.md"), "utf8"),
		).toBe("# Spec\n");
		expect(await exists(path.join(nested, "docs"))).toBe(false);
	});

	it("is refused when no folder above the working directory was set up", async () => {
		const stranger = await folder("stranger", "src");
		server.set("docs/ai/spec.md", "# Spec\n");

		await expect(createRuntime({ dest: stranger })).rejects.toThrow(
			/not inside a project set up for memory/,
		);

		expect(await exists(path.join(stranger, "docs"))).toBe(false);
		expect(await exists(path.join(stranger, ".fabric"))).toBe(false);
	});

	it("is refused when the project named is not the one the folder was set up for", async () => {
		const project = await folder("project");
		await writeProjectMarker(project, {
			projectId: PROJECT,
			gitToplevel: null,
		});

		await expect(
			createRuntime({
				dest: project,
				project: "cmanotherproject00000001",
			}),
		).rejects.toThrow(/another project/);
	});

	it("is not taken from a lock alone: a folder only ever mirrored by an older build is refused", async () => {
		const project = await folder("project");
		await mkdir(path.join(project, ".fabric"));
		await writeFile(
			path.join(project, ".fabric", "memory.lock"),
			JSON.stringify({
				version: 1,
				projectId: PROJECT,
				files: {},
				outbox: [],
			}),
		);

		await expect(createRuntime({ dest: project })).rejects.toThrow(
			/not inside a project set up for memory/,
		);
	});
});

describe("the git repository", () => {
	it("is the one init recorded: its exclude file gets the folders and the other repository's does not", async () => {
		const outer = await folder("outer");
		git(outer, "init", "-q");
		const project = await folder("outer", "packages", "app");
		git(project, "init", "-q");
		server.set("docs/ai/spec.md", "# Spec\n");
		await writeProjectMarker(project, {
			projectId: PROJECT,
			gitToplevel: project,
		});

		const { context } = await createRuntime({ dest: project });
		await pull(context);

		expect(await exclude(project)).toContain("docs/ai");
		expect(await exclude(outer)).not.toContain("docs/ai");
		expect(await exclude(outer)).not.toContain(".fabric");
	});

	it("is refused when the folder has since come to sit inside another repository", async () => {
		const outer = await folder("outer");
		git(outer, "init", "-q");
		const project = await folder("outer", "packages", "app");
		server.set("docs/ai/spec.md", "# Spec\n");
		await writeProjectMarker(project, {
			projectId: PROJECT,
			gitToplevel: null,
		});

		const { context } = await createRuntime({ dest: project });
		await expect(pull(context)).rejects.toThrow(
			/not the one this project was set up in/,
		);

		expect(await exists(path.join(project, "docs"))).toBe(false);
		expect(await exclude(outer)).not.toContain("docs/ai");
		expect(await exclude(outer)).not.toContain(".fabric");
	});

	it("is refused when it is another repository than the recorded one", async () => {
		const recorded = await folder("recorded");
		git(recorded, "init", "-q");
		const outer = await folder("outer");
		git(outer, "init", "-q");
		const project = await folder("outer", "app");
		await writeProjectMarker(project, {
			projectId: PROJECT,
			gitToplevel: recorded,
		});

		const { context } = await createRuntime({ dest: project });
		await expect(push(context)).rejects.toThrow(
			/not the one this project was set up in/,
		);
		expect(await exclude(outer)).not.toContain("docs/ai");
	});

	it("is not needed: a project folder outside any repository still mirrors", async () => {
		const project = await folder("plain");
		server.set("docs/ai/spec.md", "# Spec\n");
		await writeProjectMarker(project, {
			projectId: PROJECT,
			gitToplevel: null,
		});

		const { context } = await createRuntime({ dest: project });
		await pull(context);

		expect(
			await readFile(path.join(project, "docs/ai/spec.md"), "utf8"),
		).toBe("# Spec\n");
	});
});

describe("the files", () => {
	it("are never written outside the project folder, whatever path the server lists", async () => {
		const project = await folder("project");
		await writeProjectMarker(project, {
			projectId: PROJECT,
			gitToplevel: null,
		});
		server.targets = [
			{ id: "t1", folder: "../escape", mode: "PULL_REQUEST", version: 1 },
		];
		server.set("../escape/spec.md", "outside\n");

		const { context } = await createRuntime({ dest: project });
		await pull(context).catch(() => undefined);

		expect(await exists(path.join(directory, "escape"))).toBe(false);
		expect(await exists(path.join(directory, "escape", "spec.md"))).toBe(
			false,
		);
	});
});
