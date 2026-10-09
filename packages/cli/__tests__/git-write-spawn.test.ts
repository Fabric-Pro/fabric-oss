/**
 * What `fetchRef` and `fastForwardTo` hand to `spawn` (Fizzy #2878): the exact
 * argument vector, and an environment in which nothing can ask a person.
 *
 * `spawn` is a scripted child, so this runs no git. The tests that run real
 * git are in `git-write.test.ts`.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cloneInto,
	fastForwardTo,
	fetchRef,
	fetchRefFromUrl,
} from "../src/lib/instructions/git.js";
import { resetFetchHeadFlagForTests } from "../src/lib/instructions/git-write.js";

const { spawnMock, spawnSyncMock } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
	spawnSyncMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: spawnMock,
	spawnSync: spawnSyncMock,
}));

const TIP = "a".repeat(40);

class FakeChild extends EventEmitter {
	stdout: EventEmitter & { destroy?: () => void } = new EventEmitter();
	stderr: EventEmitter & { destroy?: () => void } = new EventEmitter();
	kill = vi.fn();
}

let spawnOptions: object | undefined;

interface Call {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	cwd: string;
}

let calls: Call[];
let answers: Array<{ code: number; stdout?: string; stderr?: string }>;

const WATCHED = [
	"GIT_ASKPASS",
	"SSH_ASKPASS",
	"GIT_SSH_COMMAND",
	"GIT_SSH",
	"GIT_DIR",
	"FABRIC_API_KEY",
	"GIT_CONFIG_COUNT",
	"GIT_TRACE",
	"GIT_TRACE_CURL",
	"GIT_TRACE_PACKET",
	"GIT_TRACE2_EVENT",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	calls = [];
	answers = [];
	for (const name of WATCHED) {
		saved[name] = process.env[name];
		delete process.env[name];
	}
	spawnMock.mockReset();
	spawnMock.mockImplementation(
		(
			command: string,
			args: string[],
			options: { env: NodeJS.ProcessEnv; cwd: string },
		) => {
			calls.push({ command, args, env: options.env, cwd: options.cwd });
			const child = new FakeChild();
			const answer = answers.shift() ?? { code: 0 };
			setImmediate(() => {
				if (answer.stdout) {
					child.stdout.emit("data", Buffer.from(answer.stdout));
				}
				if (answer.stderr) {
					child.stderr.emit("data", Buffer.from(answer.stderr));
				}
				child.emit("close", answer.code);
			});
			return child;
		},
	);
});

afterEach(() => {
	resetFetchHeadFlagForTests();
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}
});

const soon = (): number => Date.now() + 60_000;

describe("a fetch that hangs past its deadline", () => {
	it("kills what git started, lets go of its pipes and answers that it timed out", async () => {
		const hung = new FakeChild();
		const destroyed = { stdout: vi.fn(), stderr: vi.fn() };
		hung.stdout.destroy = destroyed.stdout;
		hung.stderr.destroy = destroyed.stderr;
		const unref = vi.fn();
		Object.assign(hung, { unref });
		spawnMock.mockReset();
		spawnMock.mockImplementation(
			(_command: string, _args: string[], options: object) => {
				spawnOptions = options;
				return hung;
			},
		);

		const result = await fetchRef(
			"/work/rules",
			"origin",
			"main",
			Date.now() + 40,
		);

		expect(result).toEqual({ kind: "timed-out" });
		expect(hung.kill).toHaveBeenCalledWith("SIGTERM");
		expect(destroyed.stdout).toHaveBeenCalled();
		expect(destroyed.stderr).toHaveBeenCalled();
		expect(unref).toHaveBeenCalled();
		expect(spawnOptions).toMatchObject({
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
	});
});

describe("on Windows, the deadline's taskkill", () => {
	async function hangOn(exitCode: number | null) {
		const hung = Object.assign(new FakeChild(), {
			pid: 4242,
			exitCode,
			signalCode: null,
			unref: vi.fn(),
		});
		hung.stdout.destroy = vi.fn();
		hung.stderr.destroy = vi.fn();
		spawnMock.mockReset();
		spawnMock.mockImplementation(() => hung);
		spawnSyncMock.mockReset();
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "win32" });
		try {
			await fetchRef("/work/rules", "origin", "main", Date.now() + 40);
		} finally {
			if (platform) {
				Object.defineProperty(process, "platform", platform);
			}
		}
	}

	it("ends the tree by the absolute taskkill path while git is still ours", async () => {
		await hangOn(null);

		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		const [command, args] = spawnSyncMock.mock.calls[0] as [
			string,
			string[],
		];
		expect(command).toMatch(/System32[\\/]taskkill\.exe$/i);
		expect(args).toEqual(["/PID", "4242", "/T", "/F"]);
	});

	it("does not aim taskkill at a PID after git has exited", async () => {
		await hangOn(0);

		expect(spawnSyncMock).not.toHaveBeenCalled();
	});
});

describe("on POSIX, the deadline's process group", () => {
	it("gets SIGTERM, then SIGKILL after the grace even though the leader already exited", async () => {
		const hung = Object.assign(new FakeChild(), {
			pid: 4242,
			exitCode: null,
			signalCode: null,
			unref: vi.fn(),
		});
		hung.stdout.destroy = vi.fn();
		hung.stderr.destroy = vi.fn();
		spawnMock.mockReset();
		spawnMock.mockImplementation(() => hung);
		const killed: Array<[number, string]> = [];
		const kill = vi.spyOn(process, "kill").mockImplementation(((
			pid: number,
			signal: string,
		) => {
			killed.push([pid, signal]);
			if (signal === "SIGTERM") {
				setTimeout(() => hung.emit("close", null), 10);
			}
			return true;
		}) as typeof process.kill);
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "linux" });
		try {
			const result = await fetchRef(
				"/work/rules",
				"origin",
				"main",
				Date.now() + 30,
			);

			expect(result).toEqual({ kind: "timed-out" });
			expect(killed).toEqual([
				[-4242, "SIGTERM"],
				[-4242, "SIGKILL"],
			]);
		} finally {
			kill.mockRestore();
			if (platform) {
				Object.defineProperty(process, "platform", platform);
			}
		}
	});
});

describe("Fabric gateway clone", () => {
	const url =
		"https://example.com:8443/api/v1/projects/p/instructions/repository/git/1";
	const httpAuthorization = {
		url,
		authorization: "Bearer synthetic-fixture",
	};
	it("accepts the configured HTTPS gateway port and scopes authentication to it", async () => {
		await expect(
			cloneInto("/work/rules", url, "main", soon(), {
				httpAuthorization,
			}),
		).resolves.toEqual({ kind: "cloned" });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.args).toContain(url);
		expect(calls[0]?.args.join(" ")).not.toContain("synthetic-fixture");
		expect(calls[0]?.env.FABRIC_GIT_AUTH_HEADER).toBe(
			"Authorization: Bearer synthetic-fixture",
		);
	});
	it("does not send the gateway credential to a different clone URL", async () => {
		await expect(
			cloneInto(
				"/work/rules",
				"https://other.example.com/repo",
				"main",
				soon(),
				{ httpAuthorization },
			),
		).resolves.toMatchObject({ kind: "unavailable" });
		expect(calls).toHaveLength(0);
	});
	it.each([
		"http://example.com/repo",
		"https://user:secret@example.com/repo",
		"https://example.com/repo?token=secret",
	])(
		"refuses an unsafe authenticated URL %s before spawning Git",
		async (url) => {
			await expect(
				cloneInto("/work/rules", url, "main", soon(), {
					httpAuthorization: { ...httpAuthorization, url },
				}),
			).resolves.toMatchObject({ kind: "unavailable" });
			expect(calls).toHaveLength(0);
		},
	);
});

describe("fetchRef", () => {
	it("runs the one fetch, with a refspec that is not forced, and then reads the tip", async () => {
		answers.push({ code: 0 }, { code: 0, stdout: `${TIP}\n` });

		const result = await fetchRef("/work/rules", "origin", "main", soon());

		expect(result).toEqual({ kind: "fetched", tip: TIP });
		expect(calls).toHaveLength(2);
		expect(calls[0]?.command).toBe("git");
		expect(calls[0]?.cwd).toBe("/work/rules");
		expect(calls[0]?.args).toEqual([
			...(process.platform === "win32"
				? ["-c", "core.fscache=false"]
				: []),
			"-c",
			"core.fsmonitor=false",
			"-c",
			"credential.interactive=never",
			"-c",
			"gc.auto=0",
			"-c",
			"maintenance.auto=false",
			"fetch",
			"--no-recurse-submodules",
			"--no-tags",
			"--no-write-fetch-head",
			"--",
			"origin",
			"refs/heads/main:refs/remotes/origin/main",
		]);
		expect(calls[0]?.args.some((arg) => arg.startsWith("+"))).toBe(false);
		expect(calls[0]?.args).not.toContain("--no-show-forced-updates");
		expect(calls[1]?.args.slice(-4)).toEqual([
			"rev-parse",
			"--verify",
			"-q",
			"refs/remotes/origin/main^{commit}",
		]);
	});

	it("never lets the developer's askpass programs, a Fabric key or a redirect reach it", async () => {
		process.env.GIT_ASKPASS = "/usr/bin/example-askpass";
		process.env.SSH_ASKPASS = "/usr/bin/example-ssh-askpass";
		process.env.FABRIC_API_KEY = "fab_secret";
		process.env.GIT_DIR = "/tmp/elsewhere/.git";
		process.env.GIT_CONFIG_COUNT = "1";
		answers.push({ code: 0 }, { code: 0, stdout: `${TIP}\n` });

		await fetchRef("/work/rules", "origin", "main", soon());

		const env = calls[0]?.env ?? {};
		expect(env.GIT_ASKPASS).toBeUndefined();
		expect(env.SSH_ASKPASS).toBeUndefined();
		expect(env.FABRIC_API_KEY).toBeUndefined();
		expect(env.GIT_DIR).toBeUndefined();
		expect(env.GIT_CONFIG_COUNT).toBeUndefined();
	});

	it("uses a scoped child-only Fabric header and strips every trace variable", async () => {
		process.env.GIT_TRACE = "/tmp/trace";
		process.env.GIT_TRACE_CURL = "/tmp/curl-trace";
		process.env.GIT_TRACE_PACKET = "/tmp/packet-trace";
		process.env.GIT_TRACE2_EVENT = "/tmp/trace2";
		answers.push({ code: 0 }, { code: 0, stdout: `${TIP}\n` });

		await fetchRefFromUrl(
			"/work/rules",
			"https://fabric.example/api/v1/projects/project/instructions/repository/git/1",
			"origin",
			"main",
			soon(),
			{
				url: "https://fabric.example",
				authorization: "Bearer scoped-token",
			},
		);

		const call = calls[0];
		expect(call?.args).toContain(
			"--config-env=http.https://fabric.example.extraHeader=FABRIC_GIT_AUTH_HEADER",
		);
		expect(call?.args.join(" ")).not.toContain("scoped-token");
		expect(call?.env.FABRIC_GIT_AUTH_HEADER).toBe(
			"Authorization: Bearer scoped-token",
		);
		for (const name of [
			"GIT_TRACE",
			"GIT_TRACE_CURL",
			"GIT_TRACE_PACKET",
			"GIT_TRACE2_EVENT",
		]) {
			expect(call?.env[name]).toBeUndefined();
		}
	});

	it("turns every prompt off", async () => {
		answers.push({ code: 0 }, { code: 0, stdout: `${TIP}\n` });

		await fetchRef("/work/rules", "origin", "main", soon());

		const env = calls[0]?.env ?? {};
		expect(env.GIT_TERMINAL_PROMPT).toBe("0");
		expect(env.GCM_INTERACTIVE).toBe("never");
		expect(env.GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes");
	});

	it.each([
		["GIT_SSH_COMMAND", "ssh -i /k"],
		["GIT_SSH", "/usr/bin/example-ssh"],
	])(
		"leaves the ssh program the developer chose with %s alone",
		async (name, value) => {
			process.env[name] = value;
			answers.push({ code: 0 }, { code: 0, stdout: `${TIP}\n` });

			await fetchRef("/work/rules", "origin", "main", soon());

			const env = calls[0]?.env ?? {};
			expect(env[name]).toBe(value);
			if (name === "GIT_SSH") {
				expect(env.GIT_SSH_COMMAND).toBeUndefined();
			}
		},
	);

	it("reads the tip with the read environment, not the write one", async () => {
		process.env.GIT_ASKPASS = "/usr/bin/example-askpass";
		answers.push({ code: 0 }, { code: 0, stdout: `${TIP}\n` });

		await fetchRef("/work/rules", "origin", "main", soon());

		expect(calls[1]?.env.GCM_INTERACTIVE).toBeUndefined();
		expect(calls[1]?.args).not.toContain("credential.interactive=never");
	});

	it("says the branch is missing when the fetch worked but git has no such ref", async () => {
		answers.push({ code: 0 }, { code: 1 });

		const result = await fetchRef("/work/rules", "origin", "main", soon());

		expect(result).toEqual({ kind: "failed", reason: "missing-ref" });
	});

	it("classifies a refusal by its shape and never returns git's words", async () => {
		answers.push({
			code: 128,
			stderr: "fatal: could not read Username for 'https://user:secret@example.com': terminal prompts disabled",
		});

		const result = await fetchRef("/work/rules", "origin", "main", soon());

		expect(result).toEqual({ kind: "failed", reason: "auth" });
		expect(JSON.stringify(result)).not.toContain("secret");
	});
});

describe("fastForwardTo", () => {
	it("runs one fast-forward-only merge of the commit, then checks HEAD", async () => {
		answers.push({ code: 0 }, { code: 0, stdout: `${TIP}\n` });

		const result = await fastForwardTo("/work/rules", TIP, soon());

		expect(result).toEqual({ kind: "merged", head: TIP });
		expect(calls[0]?.args).toEqual([
			...(process.platform === "win32"
				? ["-c", "core.fscache=false"]
				: []),
			"-c",
			"core.fsmonitor=false",
			"-c",
			"credential.interactive=never",
			"-c",
			"core.quotepath=false",
			"merge",
			"--ff-only",
			"--no-edit",
			"--quiet",
			TIP,
		]);
		expect(calls[1]?.args.slice(-3)).toEqual(["--verify", "-q", "HEAD"]);
	});

	it("runs with the unattended environment too", async () => {
		process.env.GIT_ASKPASS = "/usr/bin/example-askpass";
		process.env.SSH_ASKPASS = "/usr/bin/example-ssh-askpass";
		answers.push({ code: 0 }, { code: 0, stdout: `${TIP}\n` });

		await fastForwardTo("/work/rules", TIP, soon());

		const env = calls[0]?.env ?? {};
		expect(env.GIT_ASKPASS).toBeUndefined();
		expect(env.SSH_ASKPASS).toBeUndefined();
		expect(env.GIT_TERMINAL_PROMPT).toBe("0");
	});

	it("is not a success when HEAD is somewhere else afterwards", async () => {
		answers.push({ code: 0 }, { code: 0, stdout: `${"b".repeat(40)}\n` });

		const result = await fastForwardTo("/work/rules", TIP, soon());

		expect(result).toEqual({ kind: "failed", reason: "other" });
	});
});

describe("a git that does not know a fetch flag, or the gateway's option", () => {
	it("says a git without --config-env needs updating, as its own reason", async () => {
		answers.push({
			code: 129,
			stderr: "unknown option: --config-env=http.x.extraHeader=FABRIC\nusage: git [-v | --version]",
		});

		const result = await fetchRefFromUrl(
			"/work/rules",
			"https://example.com/api/v1/git/1",
			"origin",
			"main",
			soon(),
			{
				url: "https://example.com/api/v1/git/1",
				authorization: "Bearer synthetic-fixture",
			},
		);

		expect(result).toEqual({ kind: "failed", reason: "old-git" });
	});

	it("asks again without --no-write-fetch-head when git 2.28 does not know it, and remembers", async () => {
		answers.push(
			{
				code: 129,
				stderr: "error: unknown option `no-write-fetch-head'\nusage: git fetch",
			},
			{ code: 0 },
			{ code: 0, stdout: `${TIP}\n` },
			{ code: 0 },
			{ code: 0, stdout: `${TIP}\n` },
		);

		const first = await fetchRef("/work/rules", "origin", "main", soon());
		const second = await fetchRef("/work/rules", "origin", "main", soon());

		expect(first).toEqual({ kind: "fetched", tip: TIP });
		expect(second).toEqual({ kind: "fetched", tip: TIP });
		expect(calls[0]?.args).toContain("--no-write-fetch-head");
		expect(calls[1]?.args).not.toContain("--no-write-fetch-head");
		expect(calls[3]?.args).not.toContain("--no-write-fetch-head");
	});
});
