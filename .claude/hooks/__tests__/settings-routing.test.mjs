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
	it("has exactly one gate entry, with no `if` prefilter", () => {
		// The gate's triggers (`gh …` and the open-pr.sh helper) share no
		// substring, and an `if` holds one rule, so a prefilter would need two
		// entries. Claude Code does not promise to run two same-file entries for
		// one hook once, so a command matching both could run the checks twice.
		// The script exits in tens of milliseconds for every other command.
		assert.equal(gateEntries.length, 1);
		assert.equal(gateEntries[0].if, undefined);
		const group = SETTINGS.hooks.PreToolUse.find((g) =>
			g.hooks.includes(gateEntries[0]),
		);
		assert.equal(group.matcher, "Bash");
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
