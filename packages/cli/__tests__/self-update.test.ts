/**
 * The kept copy of the served build updates itself (`self-update.ts`): once a
 * day, at the end of a hook run, from the deployment the hook is bound to, and
 * only when the running file is that deployment's kept copy. Every branch is
 * pinned here against a stub deployment: the copy is replaced only by a build
 * whose integrity hash matches, and in every other case it is left as it was.
 */
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bundleCopyPath } from "../src/lib/instructions/hook-launcher.js";
import {
	refreshKeptCopy,
	SELF_UPDATE_INTERVAL_MS,
	SELF_UPDATE_OPT_OUT,
	type SelfUpdateInput,
	type SelfUpdateOutcome,
	selfUpdateLine,
} from "../src/lib/instructions/self-update.js";
import { npmTarball, sriSha512 } from "./helpers/npm-tarball.js";

const ORIGIN = "https://fabric.example.com";
const RUNNING = "/cli/fabric-0.4.0-aaaaaaaaaa.tgz";
const NEXT = "/cli/fabric-0.5.0-bbbbbbbbbb.tgz";
const OLD_BUNDLE = '#!/usr/bin/env node\nconsole.log("build a");\n';
const NEW_BUNDLE = '#!/usr/bin/env node\nconsole.log("build b");\n';
const NOW = Date.UTC(2026, 9, 4, 8, 0, 0);
const TIMING = { budgetMs: 4_000, marginMs: 1_000 };

interface Request {
	url: string;
	init: RequestInit | undefined;
}

type Route = () => Response | Promise<Response>;

/** A deployment: answers by full URL, and remembers what it was asked. */
function deployment() {
	const routes = new Map<string, Route>();
	const requests: Request[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = String(input);
		requests.push({ url, init });
		const route = routes.get(url);
		return route === undefined
			? new Response("not found", { status: 404 })
			: route();
	};
	return { routes, requests, fetchImpl };
}

/** What the pack step produces for a build: its tarball and the manifest that describes it. */
function release(
	origin: string,
	options: {
		tarballPath?: string;
		bundle?: string;
		entries?: { name: string; content: string }[];
		document?: Record<string, unknown>;
	} = {},
) {
	const tarballPath = options.tarballPath ?? NEXT;
	const tarball = npmTarball(
		options.entries ?? [
			{ name: "package/LICENSE", content: "MIT\n" },
			{
				name: "package/fabric.js",
				content: options.bundle ?? NEW_BUNDLE,
			},
			{ name: "package/package.json", content: "{}\n" },
		],
	);
	return {
		tarball,
		tarballUrl: `${origin}${tarballPath}`,
		document: {
			spec: 1,
			version: "0.5.0",
			minSupported: "0.4.0",
			nodeRange: ">=22",
			origin,
			tarball: `${origin}${tarballPath}`,
			integrity: sriSha512(tarball),
			...options.document,
		},
	};
}

function serve(
	stub: ReturnType<typeof deployment>,
	origin: string,
	build: ReturnType<typeof release>,
): void {
	stub.routes.set(`${origin}/.well-known/fabric-cli.json`, () =>
		Response.json(build.document),
	);
	stub.routes.set(
		`${origin}${new URL(build.tarballUrl).pathname}`,
		() => new Response(new Uint8Array(build.tarball)),
	);
}

let work: string;

beforeEach(async () => {
	work = await mkdtemp(path.join(tmpdir(), "fabric-self-update-"));
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** A machine that has run `init` for `origin`: the kept copy exists, and is what runs. */
async function machine(origin = ORIGIN) {
	const config = path.join(work, "config");
	const copy = bundleCopyPath(config, origin);
	await mkdir(path.dirname(copy), { recursive: true });
	await writeFile(copy, OLD_BUNDLE);
	const input: SelfUpdateInput = {
		origin,
		script: copy,
		configDirectory: config,
		runningTarball: RUNNING,
		env: {},
		deadlineAt: NOW + 10_000,
		timing: TIMING,
	};
	return {
		copy,
		input,
		stateFile: path.join(path.dirname(copy), "update-check.json"),
		folder: async () => (await readdir(path.dirname(copy))).sort(),
		bytes: () => readFile(copy, "utf8"),
	};
}

function refresh(
	input: SelfUpdateInput,
	stub: ReturnType<typeof deployment>,
	deps: { replace?: (b: Uint8Array, d: string) => Promise<boolean> } = {},
): Promise<SelfUpdateOutcome> {
	return refreshKeptCopy(input, {
		fetchImpl: stub.fetchImpl,
		now: () => NOW,
		...deps,
	});
}

async function stateOf(file: string): Promise<unknown> {
	return JSON.parse(await readFile(file, "utf8"));
}

describe("a deployment that serves a newer build", () => {
	it("replaces the copy with it, records the check, and leaves nothing else behind", async () => {
		const m = await machine();
		const stub = deployment();
		serve(stub, ORIGIN, release(ORIGIN));

		const outcome = await refresh(m.input, stub);

		expect(outcome).toEqual({
			kind: "updated",
			version: "0.5.0",
			tarball: NEXT,
		});
		expect(await m.bytes()).toBe(NEW_BUNDLE);
		expect(await stateOf(m.stateFile)).toEqual({
			checkedAt: NOW,
			tarball: NEXT,
		});
		expect(await m.folder()).toEqual(["fabric.mjs", "update-check.json"]);
		expect(stub.requests.map((request) => request.url)).toEqual([
			`${ORIGIN}/.well-known/fabric-cli.json`,
			`${ORIGIN}${NEXT}`,
		]);
	});

	it("asks for neither a redirect nor another host", async () => {
		const m = await machine();
		const stub = deployment();
		serve(stub, ORIGIN, release(ORIGIN));

		await refresh(m.input, stub);

		expect(stub.requests.map((request) => request.init?.redirect)).toEqual([
			"error",
			"error",
		]);
	});

	it("takes the tarball from the bound origin even when the document names a different host", async () => {
		const m = await machine();
		const stub = deployment();
		const build = release(ORIGIN, {
			document: { tarball: `https://elsewhere.example.net${NEXT}` },
		});
		serve(stub, ORIGIN, build);

		const outcome = await refresh(m.input, stub);

		expect(outcome.kind).toBe("updated");
		expect(
			stub.requests.every((request) => request.url.startsWith(ORIGIN)),
		).toBe(true);
	});

	it("reports one line, which names the version and says when it takes effect", async () => {
		const m = await machine();
		const stub = deployment();
		serve(stub, ORIGIN, release(ORIGIN));

		const line = selfUpdateLine(await refresh(m.input, stub));

		expect(line).toBe(
			"fabric: this CLI copy was updated to 0.5.0; it runs from the next session",
		);
	});

	it("writes nothing to stdout", async () => {
		const m = await machine();
		const stub = deployment();
		serve(stub, ORIGIN, release(ORIGIN));
		const stdout = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);

		await refresh(m.input, stub);

		expect(stdout).not.toHaveBeenCalled();
	});
});

describe("a deployment that serves the build already running", () => {
	it("downloads nothing and leaves the copy alone", async () => {
		const m = await machine();
		const stub = deployment();
		serve(stub, ORIGIN, release(ORIGIN, { tarballPath: RUNNING }));

		const outcome = await refresh(m.input, stub);

		expect(outcome).toEqual({ kind: "current" });
		expect(stub.requests.map((request) => request.url)).toEqual([
			`${ORIGIN}/.well-known/fabric-cli.json`,
		]);
		expect(await m.bytes()).toBe(OLD_BUNDLE);
		expect(await stateOf(m.stateFile)).toEqual({
			checkedAt: NOW,
			tarball: RUNNING,
		});
		expect(selfUpdateLine(outcome)).toBeNull();
	});
});

describe("a download that cannot be trusted", () => {
	it("is refused when it does not match the integrity hash, and the copy is untouched", async () => {
		const m = await machine();
		const stub = deployment();
		const build = release(ORIGIN, {
			document: { integrity: sriSha512(Buffer.from("something else")) },
		});
		serve(stub, ORIGIN, build);

		const outcome = await refresh(m.input, stub);

		expect(outcome).toMatchObject({
			kind: "failed",
			reason: expect.stringContaining("integrity hash"),
		});
		expect(await m.bytes()).toBe(OLD_BUNDLE);
		expect(await m.folder()).toEqual(["fabric.mjs", "update-check.json"]);
	});

	it("is refused when the package does not hold the CLI where it should", async () => {
		const m = await machine();
		const stub = deployment();
		serve(
			stub,
			ORIGIN,
			release(ORIGIN, {
				entries: [{ name: "package/LICENSE", content: "MIT\n" }],
			}),
		);

		const outcome = await refresh(m.input, stub);

		expect(outcome).toMatchObject({ kind: "failed" });
		expect(await m.bytes()).toBe(OLD_BUNDLE);
	});

	it("is refused when what it holds is not a runnable CLI", async () => {
		const m = await machine();
		const stub = deployment();
		serve(stub, ORIGIN, release(ORIGIN, { bundle: "<html>nope</html>" }));

		const outcome = await refresh(m.input, stub);

		expect(outcome).toMatchObject({
			kind: "failed",
			reason: "the download is not a runnable CLI",
		});
		expect(await m.bytes()).toBe(OLD_BUNDLE);
	});

	it("is refused when it is larger than allowed, before it is read in full", async () => {
		const m = await machine();
		const stub = deployment();
		const build = release(ORIGIN);
		serve(stub, ORIGIN, build);
		stub.routes.set(
			`${ORIGIN}${NEXT}`,
			() => new Response(Buffer.alloc(9 * 1024 * 1024)),
		);

		const outcome = await refresh(m.input, stub);

		expect(outcome).toMatchObject({
			kind: "failed",
			reason: "the download is larger than allowed",
		});
		expect(await m.bytes()).toBe(OLD_BUNDLE);
	});

	it.each([
		["a path outside /cli", "/elsewhere/fabric-0.5.0-bbbbbbbbbb.tgz"],
		["a path that climbs", "/cli/../fabric-0.5.0-bbbbbbbbbb.tgz"],
		["a name without the build id", "/cli/fabric-0.5.0.tgz"],
		["a name that is not a tarball", "/cli/fabric-0.5.0-bbbbbbbbbb.sh"],
	])("never asks for %s", async (_label, tarball) => {
		const m = await machine();
		const stub = deployment();
		const build = release(ORIGIN);
		serve(stub, ORIGIN, build);
		stub.routes.set(`${ORIGIN}/.well-known/fabric-cli.json`, () =>
			Response.json({ ...build.document, tarball }),
		);

		const outcome = await refresh(m.input, stub);

		expect(outcome.kind).toBe("failed");
		expect(stub.requests).toHaveLength(1);
		expect(await m.bytes()).toBe(OLD_BUNDLE);
	});

	it("is refused when the document is in a form this CLI does not read", async () => {
		const m = await machine();
		const stub = deployment();
		serve(stub, ORIGIN, release(ORIGIN, { document: { spec: 2 } }));

		const outcome = await refresh(m.input, stub);

		expect(outcome.kind).toBe("failed");
		expect(stub.requests).toHaveLength(1);
		expect(await m.bytes()).toBe(OLD_BUNDLE);
	});
});

describe("a copy that cannot be replaced", () => {
	it("keeps the earlier copy and says so", async () => {
		const m = await machine();
		const stub = deployment();
		serve(stub, ORIGIN, release(ORIGIN));

		const outcome = await refresh(m.input, stub, {
			replace: async () => false,
		});

		expect(outcome).toEqual({
			kind: "failed",
			reason: "the copy is in use",
			cause: undefined,
		});
		expect(await m.bytes()).toBe(OLD_BUNDLE);
		expect(selfUpdateLine(outcome)).toBe(
			"fabric: this CLI copy was not updated (the copy is in use); the earlier copy was kept",
		);
	});
});

describe("a deployment that does not answer", () => {
	it("is asked about once a day even when it fails, so a down deployment costs one request", async () => {
		const m = await machine();
		const stub = deployment();

		const first = await refresh(m.input, stub);
		const second = await refresh(m.input, stub);

		expect(first).toMatchObject({
			kind: "failed",
			reason: "the deployment answered HTTP 404",
		});
		expect(second).toEqual({ kind: "skipped", reason: "checked-recently" });
		expect(stub.requests).toHaveLength(1);
	});

	it("is a failure that leaves the copy alone when the network is down", async () => {
		const m = await machine();

		const outcome = await refreshKeptCopy(m.input, {
			fetchImpl: async () => {
				throw new TypeError("fetch failed");
			},
			now: () => NOW,
		});

		expect(outcome).toMatchObject({
			kind: "failed",
			reason: "the deployment could not be reached",
		});
		expect(await m.bytes()).toBe(OLD_BUNDLE);
	});

	it("is given up on when it is slower than the step's own budget", async () => {
		const m = await machine();
		const started = Date.now();

		const outcome = await refreshKeptCopy(
			{ ...m.input, timing: { budgetMs: 50, marginMs: 0 } },
			{
				fetchImpl: (_input, init) =>
					new Promise((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () =>
							reject(new DOMException("aborted", "AbortError")),
						);
					}),
				now: () => NOW,
			},
		);

		expect(outcome).toMatchObject({
			kind: "failed",
			reason: "it ran out of time",
		});
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(await m.bytes()).toBe(OLD_BUNDLE);
	});
});

describe("when it does not run at all", () => {
	async function expectQuiet(
		m: Awaited<ReturnType<typeof machine>>,
		input: SelfUpdateInput,
		reason: string,
	): Promise<void> {
		const stub = deployment();
		serve(stub, input.origin, release(input.origin));

		const outcome = await refresh(input, stub);

		expect(outcome).toEqual({ kind: "skipped", reason });
		expect(stub.requests).toEqual([]);
		expect(await m.bytes()).toBe(OLD_BUNDLE);
		expect(selfUpdateLine(outcome)).toBeNull();
	}

	it("has too little of the hook's deadline left", async () => {
		const m = await machine();
		const input = { ...m.input, deadlineAt: NOW + 4_999 };

		await expectQuiet(m, input, "no-time");

		expect(await m.folder()).toEqual(["fabric.mjs"]);
	});

	it("has exactly the budget and the margin left, and runs", async () => {
		const m = await machine();
		const stub = deployment();
		serve(stub, ORIGIN, release(ORIGIN));

		const outcome = await refresh(
			{ ...m.input, deadlineAt: NOW + 5_000 },
			stub,
		);

		expect(outcome.kind).toBe("updated");
	});

	it("asked less than a day ago", async () => {
		const m = await machine();
		await writeFile(
			m.stateFile,
			JSON.stringify({
				checkedAt: NOW - (SELF_UPDATE_INTERVAL_MS - 1),
				tarball: RUNNING,
			}),
		);

		await expectQuiet(m, m.input, "checked-recently");
	});

	it.each([
		["a day ago", NOW - SELF_UPDATE_INTERVAL_MS],
		["in the future, which a clock set backwards leaves", NOW + 60_000],
	])("asked %s, which is time to ask again", async (_label, checkedAt) => {
		const m = await machine();
		await writeFile(
			m.stateFile,
			JSON.stringify({ checkedAt, tarball: RUNNING }),
		);
		const stub = deployment();
		serve(stub, ORIGIN, release(ORIGIN));

		const outcome = await refresh(m.input, stub);

		expect(outcome.kind).toBe("updated");
	});

	it("has a state file it cannot read, which counts as never having asked", async () => {
		const m = await machine();
		await writeFile(m.stateFile, "{not json");
		const stub = deployment();
		serve(stub, ORIGIN, release(ORIGIN));

		const outcome = await refresh(m.input, stub);

		expect(outcome.kind).toBe("updated");
	});

	it.each(["1", "true", "yes"])(
		`is switched off by ${SELF_UPDATE_OPT_OUT}=%s`,
		async (value) => {
			const m = await machine();

			await expectQuiet(
				m,
				{ ...m.input, env: { [SELF_UPDATE_OPT_OUT]: value } },
				"opted-out",
			);
		},
	);

	it.each(["", "0", "false"])(
		`is not switched off by ${SELF_UPDATE_OPT_OUT}='%s', which says no`,
		async (value) => {
			const m = await machine();
			const stub = deployment();
			serve(stub, ORIGIN, release(ORIGIN));

			const outcome = await refresh(
				{ ...m.input, env: { [SELF_UPDATE_OPT_OUT]: value } },
				stub,
			);

			expect(outcome.kind).toBe("updated");
		},
	);

	it.each(["1", "true"])("is off under CI=%s", async (value) => {
		const m = await machine();

		await expectQuiet(m, { ...m.input, env: { CI: value } }, "ci");
	});

	it("is the build npm publishes, which has no copy to replace", async () => {
		const m = await machine();

		await expectQuiet(
			m,
			{ ...m.input, runningTarball: undefined },
			"not-a-kept-copy",
		);
	});

	it("is the served build run by npx from its tarball, not from the kept copy", async () => {
		const m = await machine();
		const npxRun = path.join(work, "_npx", "ab12cd", "fabric.js");
		await mkdir(path.dirname(npxRun), { recursive: true });
		await writeFile(npxRun, OLD_BUNDLE);

		await expectQuiet(m, { ...m.input, script: npxRun }, "not-a-kept-copy");
	});

	it("is another deployment's kept copy, which is not this hook's to replace", async () => {
		const m = await machine();
		const other = bundleCopyPath(
			m.input.configDirectory,
			"https://other.example.com",
		);
		await mkdir(path.dirname(other), { recursive: true });
		await writeFile(other, OLD_BUNDLE);

		await expectQuiet(m, { ...m.input, script: other }, "not-a-kept-copy");
	});

	it("has no kept copy yet, because init has not run for this deployment", async () => {
		const m = await machine();
		const input = {
			...m.input,
			origin: "https://never-initialised.example.com",
		};

		await expectQuiet(m, input, "not-a-kept-copy");
	});

	it("is bound to a deployment reached over plain http", async () => {
		const origin = "http://fabric.example.com";
		const m = await machine(origin);

		await expectQuiet(m, m.input, "insecure-origin");
	});

	it.each([
		"http://localhost:3001",
		"http://127.0.0.1:38917",
		"http://[::1]:3001",
	])(
		"runs against the loopback host %s, which a developer's own deployment uses",
		async (origin) => {
			const m = await machine(origin);
			const stub = deployment();
			serve(stub, origin, release(origin));

			const outcome = await refresh(m.input, stub);

			expect(outcome.kind).toBe("updated");
			expect(await m.bytes()).toBe(NEW_BUNDLE);
		},
	);
});

describe("selfUpdateLine", () => {
	it("is one line for a failure, without a trailing newline", () => {
		const line = selfUpdateLine({
			kind: "failed",
			reason: "the deployment could not be reached",
		});

		expect(line).toBe(
			"fabric: this CLI copy was not updated (the deployment could not be reached); the earlier copy was kept",
		);
		expect(line).not.toContain("\n");
	});

	it("is nothing for a run that did not ask or found nothing new", () => {
		expect(selfUpdateLine({ kind: "current" })).toBeNull();
		expect(
			selfUpdateLine({ kind: "skipped", reason: "checked-recently" }),
		).toBeNull();
	});
});
