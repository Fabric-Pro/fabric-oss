import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	CHECK_TIMEOUTS_MS,
	effectiveTimeoutMs,
	HOOK_TIMEOUT_SECONDS,
} from "../lib/gate-timeouts.mjs";

import { GATED_GH_API_COMMANDS } from "./gate-fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETTINGS = JSON.parse(
	readFileSync(resolve(HERE, "..", "..", "settings.json"), "utf8"),
);

/** All hook entries under every PreToolUse matcher group. */
const entries = SETTINGS.hooks.PreToolUse.flatMap((group) => group.hooks);
const gateEntries = entries.filter((e) =>
	String(e.command).endsWith("pr-quality-gate.mjs"),
);

describe("settings.json — pr-quality-gate routing", () => {
	it("has exactly one gate entry, and its prefilter covers everything the script gates", () => {
		assert.equal(gateEntries.length, 1);
		const glob = gateEntries[0].if.match(/^Bash\((.*)\)$/s)?.[1];
		assert.ok(glob, "entry must use a Bash(<glob>) condition");
		const re = new RegExp(
			`^${glob
				.split("*")
				.map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
				.join("[\\s\\S]*")}$`,
		);
		const commands = [
			"gh pr create --fill",
			"gh pr edit 5 --body x",
			...GATED_GH_API_COMMANDS,
		];
		for (const command of commands) {
			assert.match(command, re, command);
		}
	});

	it("gives every gate entry the shared hook timeout", () => {
		assert.ok(gateEntries.length >= 1);
		for (const entry of gateEntries) {
			assert.equal(entry.timeout, HOOK_TIMEOUT_SECONDS, entry.if);
		}
	});

	it("keeps the per-check limits (plus 30 s margin) within the hook timeout", () => {
		const sumSeconds =
			Object.values(CHECK_TIMEOUTS_MS).reduce((a, b) => a + b, 0) / 1000;
		assert.ok(
			sumSeconds + 30 <= HOOK_TIMEOUT_SECONDS,
			`${sumSeconds}s + 30s exceeds ${HOOK_TIMEOUT_SECONDS}s`,
		);
	});

	it("lets FABRIC_GATE_TIMEOUT_MS shorten a limit but never lengthen it", () => {
		for (const limit of Object.values(CHECK_TIMEOUTS_MS)) {
			assert.equal(
				effectiveTimeoutMs(limit, { FABRIC_GATE_TIMEOUT_MS: "500" }),
				500,
			);
			assert.equal(
				effectiveTimeoutMs(limit, {
					FABRIC_GATE_TIMEOUT_MS: "999999999",
				}),
				limit,
			);
			assert.equal(
				effectiveTimeoutMs(limit, { FABRIC_GATE_TIMEOUT_MS: "0" }),
				limit,
			);
			assert.equal(effectiveTimeoutMs(limit, {}), limit);
		}
	});
});
