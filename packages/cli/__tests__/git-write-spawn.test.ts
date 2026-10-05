/**
 * What `fetchRef` and `fastForwardTo` hand to `spawn` (Fizzy #2878): the exact
 * argument vector, and an environment in which nothing can ask a person.
 *
 * `spawn` is a scripted child, so this runs no git. The tests that run real
 * git are in `git-write.test.ts`.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fastForwardTo, fetchRef } from "../src/lib/instructions/git.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: spawnMock,
}));

const TIP = "a".repeat(40);

class FakeChild extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	kill = vi.fn();
}

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
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}
});

const soon = (): number => Date.now() + 60_000;

describe("fetchRef", () => {
	it("runs the one fetch, with a refspec that is not forced, and then reads the tip", async () => {
		answers.push({ code: 0 }, { code: 0, stdout: `${TIP}\n` });

		const result = await fetchRef("/work/rules", "origin", "main", soon());

		expect(result).toEqual({ kind: "fetched", tip: TIP });
		expect(calls).toHaveLength(2);
		expect(calls[0]?.command).toBe("git");
		expect(calls[0]?.cwd).toBe("/work/rules");
		expect(calls[0]?.args).toEqual([
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
			"--",
			"origin",
			"refs/heads/main:refs/remotes/origin/main",
		]);
		expect(calls[0]?.args.some((arg) => arg.startsWith("+"))).toBe(false);
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
			"-c",
			"core.fsmonitor=false",
			"-c",
			"credential.interactive=never",
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
