/**
 * The kept copy's update when the session hook has no time left for it: it
 * runs in a detached child that holds none of the hook's pipes, so a slow
 * session start neither delays the hook past its deadline nor means the copy is
 * never refreshed.
 */
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { bundleCopyPath } from "../src/lib/instructions/hook-launcher.js";
import {
	refreshKeptCopy,
	startBackgroundSelfUpdate,
} from "../src/lib/instructions/self-update.js";

function fakeSpawn(behaviour: "ok" | "throws" = "ok") {
	const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
	const impl = vi.fn((..._args: unknown[]) => {
		if (behaviour === "throws") {
			throw new Error("spawn failed");
		}
		return child;
	});
	return { child, impl: impl as unknown as typeof spawn, calls: impl.mock };
}

describe("startBackgroundSelfUpdate", () => {
	it("starts the hidden command detached with every stream ignored, and lets go of it", () => {
		const { child, impl, calls } = fakeSpawn();

		const started = startBackgroundSelfUpdate(
			{
				script: "/home/dev/.config/fabric/cli/fabric.mjs",
				origin: "https://deploy.example.com",
				env: { PATH: "/usr/bin" },
			},
			impl,
		);

		expect(started).toBe(true);
		const [command, args, options] = calls.calls[0] as [
			string,
			string[],
			Record<string, unknown>,
		];
		expect(command).toBe(process.execPath);
		expect(args).toEqual([
			"/home/dev/.config/fabric/cli/fabric.mjs",
			"instructions",
			"self-update",
			"--base-url",
			"https://deploy.example.com",
		]);
		expect(options).toMatchObject({ detached: true, stdio: "ignore" });
		expect(child.unref).toHaveBeenCalled();
	});

	it("says it could not start when spawn throws, and never throws itself", () => {
		const { impl } = fakeSpawn("throws");

		expect(
			startBackgroundSelfUpdate(
				{
					script: "/x/fabric.mjs",
					origin: "https://deploy.example.com",
					env: {},
				},
				impl,
			),
		).toBe(false);
	});
});

describe("refreshKeptCopy with too little of the deadline left", () => {
	async function keptCopy() {
		const configDirectory = await mkdtemp(
			path.join(tmpdir(), "fabric-selfupdate-"),
		);
		const origin = "https://deploy.example.com";
		const script = bundleCopyPath(configDirectory, origin);
		await mkdir(path.dirname(script), { recursive: true });
		await writeFile(script, "#!/usr/bin/env node\n");
		return {
			script,
			input: {
				origin,
				script,
				configDirectory,
				runningTarball: "/cli/fabric-1.0.0-0123456789.tgz",
				env: {},
				deadlineAt: 10_000 + 2_000,
				timing: { budgetMs: 4_000, marginMs: 1_000 },
			},
		};
	}

	it("asks nothing and answers no-time, which is what starts the background child", async () => {
		const fetchImpl = vi.fn();
		const { input } = await keptCopy();

		const outcome = await refreshKeptCopy(input, {
			now: () => Date.now(),
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		expect(outcome).toEqual({ kind: "skipped", reason: "no-time" });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("lets only one of two simultaneous runs ask the deployment", async () => {
		const { input } = await keptCopy();
		const fetchImpl = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
			return new Response(
				JSON.stringify({
					spec: 1,
					tarball: input.runningTarball,
					integrity: `sha512-${"A".repeat(86)}==`,
				}),
			);
		});
		const roomy = { ...input, deadlineAt: Date.now() + 60_000 };

		const outcomes = await Promise.all([
			refreshKeptCopy(roomy, {
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
			refreshKeptCopy(roomy, {
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
		]);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual([
			"current",
			"skipped",
		]);
	});

	it("answers checked-recently, not no-time, when it asked within the day", async () => {
		const { input, script } = await keptCopy();
		const now = Date.now();
		await writeFile(
			path.join(path.dirname(script), "update-check.json"),
			`${JSON.stringify({ checkedAt: now, tarball: input.runningTarball })}\n`,
		);

		const outcome = await refreshKeptCopy(
			{ ...input, deadlineAt: now + 2_000 },
			{ now: () => now },
		);

		expect(outcome).toEqual({
			kind: "skipped",
			reason: "checked-recently",
		});
	});
});
