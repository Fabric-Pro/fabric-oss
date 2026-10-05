/**
 * Every write to the CLI's configuration is a read and a rewrite of one file,
 * and a login, a logout, a `fabric ctx` and a session hook's renewal can each
 * run in a process of their own. Without a lock, a write that read the file
 * before another process's write puts the file back as it was: a renewal's
 * rotated refresh token comes back as the spent one, and replaying a spent
 * refresh token ends every sign-in this CLI has made, for every project.
 *
 * These tests run real writers in separate processes (`helpers/config-writer.ts`,
 * started with `node --import tsx`) and read the file they leave.
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
	mkdtemp,
	readFile,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CLI_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const WRITER = path.join(CLI_ROOT, "__tests__", "helpers", "config-writer.ts");
const ORIGIN = "https://deploy.example.com";

const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalAppData = process.env.APPDATA;
let home: string;

beforeEach(async () => {
	home = await mkdtemp(path.join(tmpdir(), "fabric-config-lock-"));
	process.env.XDG_CONFIG_HOME = home;
	process.env.APPDATA = home;
	vi.resetModules();
});

afterEach(async () => {
	for (const [name, value] of [
		["XDG_CONFIG_HOME", originalConfigHome],
		["APPDATA", originalAppData],
	] as const) {
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}
	vi.resetModules();
	await rm(home, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

function session(label: string) {
	return {
		issuer: ORIGIN,
		clientId: "client-example",
		redirectUri: "http://127.0.0.1:49152/callback",
		tokenEndpoint: `${ORIGIN}/api/auth/oauth2/token`,
		accessToken: `fat_${label}`,
		refreshToken: `frt_${label}`,
		expiresAt: 1_900_000_000_000,
	};
}

function startWriter(...args: string[]): {
	child: ChildProcess;
	done: Promise<{ code: number | null; stderr: string }>;
} {
	const child = spawn(
		process.execPath,
		["--import", "tsx", WRITER, ...args],
		{
			cwd: CLI_ROOT,
			env: process.env,
			stdio: ["ignore", "ignore", "pipe"],
		},
	);
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const done = new Promise<{ code: number | null; stderr: string }>(
		(resolve) => {
			child.on("close", (code) => resolve({ code, stderr }));
		},
	);
	return { child, done };
}

async function onDisk(file: string): Promise<{
	profiles: Record<
		string,
		{
			oauth?: { refreshToken?: string };
			projects?: Record<string, unknown>;
			defaultContext?: unknown;
		}
	>;
}> {
	return JSON.parse(await readFile(file, "utf8"));
}

async function exists(file: string): Promise<boolean> {
	return stat(file).then(
		() => true,
		() => false,
	);
}

describe("writes to the configuration, from several processes at once", () => {
	it("keep a renewal's rotated refresh token, every other write, and nothing that was removed", async () => {
		const config = await import("../src/lib/config.js");
		config.saveOAuth(session("organization"), { baseUrl: ORIGIN });
		const rounds = 40;

		const writers = [
			startWriter("rotate", String(rounds)),
			startWriter("churn", "a", String(rounds)),
			startWriter("churn", "b", String(rounds)),
		];
		for (let index = 1; index <= rounds; index++) {
			config.saveDefaultContext(
				{ type: "org", slug: `parent-${index}` },
				ORIGIN,
			);
		}
		const results = await Promise.all(writers.map((writer) => writer.done));

		expect(results).toEqual([
			{ code: 0, stderr: "" },
			{ code: 0, stderr: "" },
			{ code: 0, stderr: "" },
		]);
		const stored = (await onDisk(config.getConfigPath())).profiles[ORIGIN];
		expect(stored?.oauth?.refreshToken).toBe(`frt_rotated_${rounds}`);
		expect(Object.keys(stored?.projects ?? {}).sort()).toEqual([
			`a-${rounds}`,
			`b-${rounds}`,
		]);
		expect(stored?.defaultContext).toEqual({
			type: "org",
			slug: `parent-${rounds}`,
		});
	}, 120_000);

	it("take the lock beside the file and leave none behind", async () => {
		const config = await import("../src/lib/config.js");
		config.saveOAuth(session("organization"), { baseUrl: ORIGIN });

		config.saveDefaultContext({ type: "personal" }, ORIGIN);

		expect(await exists(`${config.getConfigPath()}.write.lock`)).toBe(
			false,
		);
	});

	it("wait for a write that is in progress in another process, and then see what it wrote", async () => {
		const config = await import("../src/lib/config.js");
		config.saveOAuth(session("organization"), { baseUrl: ORIGIN });
		const lock = `${config.getConfigPath()}.write.lock`;
		await writeFile(lock, "12345", { flag: "wx" });
		const writer = startWriter("context", "1");

		await new Promise((resolve) => setTimeout(resolve, 1500));
		const whileHeld = await onDisk(config.getConfigPath());
		await rm(lock);
		const result = await writer.done;

		expect(whileHeld.profiles[ORIGIN]?.defaultContext).toBeUndefined();
		expect(result).toEqual({ code: 0, stderr: "" });
		expect(
			(await onDisk(config.getConfigPath())).profiles[ORIGIN]
				?.defaultContext,
		).toEqual({ type: "org", slug: "org-1" });
	}, 60_000);

	it("take over a lock whose holder died", async () => {
		const config = await import("../src/lib/config.js");
		config.saveOAuth(session("organization"), { baseUrl: ORIGIN });
		const lock = `${config.getConfigPath()}.write.lock`;
		await writeFile(lock, "12345", { flag: "wx" });
		const old = new Date(Date.now() - 60_000);
		await utimes(lock, old, old);

		config.saveDefaultContext({ type: "personal" }, ORIGIN);

		expect(
			(await onDisk(config.getConfigPath())).profiles[ORIGIN]
				?.defaultContext,
		).toEqual({ type: "personal" });
		expect(await exists(lock)).toBe(false);
	});
});

describe("a renewal's write and the write lock", () => {
	it("do not wait for each other: the renewal holds the refresh lock and writes under the other one", async () => {
		const config = await import("../src/lib/config.js");
		const session_ = await import("../src/lib/oauth/session.js");
		config.saveOAuth(
			{ ...session("organization"), expiresAt: Date.now() - 1000 },
			{ baseUrl: ORIGIN },
		);

		const token = await session_.refreshAccessToken(() => true, {
			origin: ORIGIN,
			now: () => 1_000_000,
			fetch: async () =>
				new Response(
					JSON.stringify({
						access_token: "fat_renewed",
						refresh_token: "frt_renewed",
						expires_in: 3600,
						token_type: "Bearer",
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
		});

		expect(token).toBe("fat_renewed");
		expect(config.getOAuth(ORIGIN)?.refreshToken).toBe("frt_renewed");
	}, 30_000);
});
