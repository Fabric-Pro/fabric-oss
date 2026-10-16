import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LAUNCHER_PATH = fileURLToPath(
	new URL("../launchers/twilio.cjs", import.meta.url),
);

// Built at runtime so secret scanners don't flag these fake test IDs.
const FAKE_ACCOUNT_SID = `AC${"0".repeat(32)}`;
const FAKE_API_KEY_SID = `SK${"0".repeat(32)}`;

describe("Twilio MCP launcher", () => {
	let tempDir: string;
	let fakeBinPath: string;

	before(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "twilio-launcher-test-"));
		fakeBinPath = join(tempDir, "fake-twilio.cjs");
		await writeFile(
			fakeBinPath,
			`"use strict";
console.log(JSON.stringify({
	argv: process.argv,
	env: {
		TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
		TWILIO_API_KEY: process.env.TWILIO_API_KEY,
		TWILIO_API_SECRET: process.env.TWILIO_API_SECRET,
	},
}));
`,
		);
	});

	after(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("passes credentials as argv arguments and deletes them from process.env", async () => {
		const env = {
			...process.env,
			TWILIO_ACCOUNT_SID: FAKE_ACCOUNT_SID,
			TWILIO_API_KEY: FAKE_API_KEY_SID,
			TWILIO_API_SECRET: "secret123",
		};

		const { stdout } = await execFileAsync(
			process.execPath,
			[LAUNCHER_PATH, fakeBinPath, "--other-flag"],
			{ env },
		);

		const result = JSON.parse(stdout);
		assert.equal("TWILIO_ACCOUNT_SID" in result.env, false);
		assert.equal("TWILIO_API_KEY" in result.env, false);
		assert.equal("TWILIO_API_SECRET" in result.env, false);
		assert.equal(result.argv[0], process.execPath);
		assert.equal(result.argv[1], fakeBinPath);
		assert.equal(result.argv[2], "--other-flag");
		assert.deepEqual(result.argv.slice(3), [
			`--accountSid=${FAKE_ACCOUNT_SID}`,
			`--apiKey=${FAKE_API_KEY_SID}`,
			"--apiSecret=secret123",
		]);
	});

	const failureCases: Array<
		[string, (bin: string) => string[], Record<string, string>?]
	> = [
		["missing binPath", () => []],
		[
			"missing TWILIO_ACCOUNT_SID",
			(bin) => [bin],
			{ TWILIO_API_KEY: "SK123", TWILIO_API_SECRET: "sec" },
		],
		[
			"missing TWILIO_API_KEY",
			(bin) => [bin],
			{ TWILIO_ACCOUNT_SID: "AC123", TWILIO_API_SECRET: "sec" },
		],
		[
			"missing TWILIO_API_SECRET",
			(bin) => [bin],
			{ TWILIO_ACCOUNT_SID: "AC123", TWILIO_API_KEY: "SK123" },
		],
	];

	for (const [label, getArgs, customEnv] of failureCases) {
		it(`exits with 1 when ${label}`, async () => {
			const env = {
				PATH: process.env.PATH,
				...customEnv,
			};

			await assert.rejects(
				execFileAsync(
					process.execPath,
					[LAUNCHER_PATH, ...getArgs(fakeBinPath)],
					{
						env,
					},
				),
				(err: any) => {
					assert.equal(err.code, 1);
					assert.match(
						err.stderr,
						/Twilio launcher: missing package path or credentials/,
					);
					return true;
				},
			);
		});
	}
});
