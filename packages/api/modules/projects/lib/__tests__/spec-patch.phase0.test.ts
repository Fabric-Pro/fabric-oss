/**
 * PHASE 0 (manual, gated) — the architecture-deciding spike for Feature
 * Maturation V2: does the LLM return a TIGHT scoped `{from,to}` patch for a
 * confirmed decision, or does it rewrite the whole spec?
 *
 * If tight patches hold, the Clean Spec stays one freetext markdown field and we
 * need no stored anchors. If the model rewrites everything (or paraphrases the
 * `from` block so `applySpecPatch` can't locate it), we need a fallback. This
 * test answers that empirically across the cases that actually stress the
 * verbatim-`from` contract:
 *   1. DELETION       — remove a standalone list item (the easy case).
 *   2. REPLACEMENT    — rewrite a list item in place (`to !== ""`).
 *   3. INTRO PROSE    — edit a free paragraph with no clean list boundary.
 *   4. MULTI-CRITERIA — one decision that touches two criteria at once.
 *
 * Skipped unless RUN_PHASE0=1 (makes real model calls). Run with a tenant that
 * has a configured AI provider — model resolution is DB-coupled, there is no
 * env/gateway fallback. The decrypt secret is BETTER_AUTH_SECRET. Pass a real
 * userId/org via PHASE0_USER_ID / PHASE0_ORG_ID:
 *   cd packages/api && RUN_PHASE0=1 DATABASE_URL=… BETTER_AUTH_SECRET=… \
 *     PHASE0_USER_ID=… PHASE0_ORG_ID=… \
 *     npx vitest run --disableConsoleIntercept \
 *     modules/projects/lib/__tests__/spec-patch.phase0.test.ts
 */

import { generateObject, getAIModelWithMetadata } from "@repo/ai";
import { zodSchema } from "ai";
import { describe, expect, it } from "vitest";
import {
	applySpecPatches,
	buildSpecPatchPrompt,
	SpecPatchSetSchema,
} from "../spec-patch";

const DEV_USER_ID = process.env.PHASE0_USER_ID ?? "cmpmwnm8v0000zf46c657pee2";
const ORG_ID = process.env.PHASE0_ORG_ID;

const SPEC = `# User Login

Users authenticate before reaching the dashboard. The login screen is the first
authenticated surface and must work on web and mobile web.

## Acceptance Criteria

- AC#1: The user can log in with email and password.
- AC#2: The user is prompted for a TOTP multi-factor code after a correct password.
- AC#3: The user can reset a forgotten password via an emailed magic link.
- AC#4: The user is locked out for 15 minutes after 5 failed attempts.
- AC#5: A successful login redirects to the dashboard the user last visited.`;

interface Scenario {
	name: string;
	decision: string;
	/** Lines that MUST survive untouched (regression guard for over-reach). */
	preserved: string[];
	/** Minimum patches the decision should logically produce. */
	minPatches: number;
}

const SCENARIOS: Scenario[] = [
	{
		name: "1-DELETION (standalone list item)",
		decision: `For v1 we will ship email-only login and DEFER multi-factor
authentication entirely. Drop the MFA/TOTP requirement. Everything else stays.`,
		preserved: [
			"- AC#1: The user can log in with email and password.",
			"- AC#3: The user can reset a forgotten password via an emailed magic link.",
			"- AC#5: A successful login redirects to the dashboard the user last visited.",
		],
		minPatches: 1,
	},
	{
		name: "2-REPLACEMENT (rewrite a list item in place)",
		decision: `We are loosening the lockout policy: lock the user out for 30
minutes after 10 failed attempts (was 15 minutes after 5). Nothing else changes.`,
		preserved: [
			"- AC#1: The user can log in with email and password.",
			"- AC#2: The user is prompted for a TOTP multi-factor code after a correct password.",
			"- AC#5: A successful login redirects to the dashboard the user last visited.",
		],
		minPatches: 1,
	},
	{
		name: "3-INTRO PROSE (free paragraph, no list boundary)",
		decision: `Login is no longer web-only: the login screen must also work in
the native iOS and Android apps, in addition to web and mobile web.`,
		preserved: [
			"- AC#1: The user can log in with email and password.",
			"- AC#2: The user is prompted for a TOTP multi-factor code after a correct password.",
			"- AC#4: The user is locked out for 15 minutes after 5 failed attempts.",
		],
		minPatches: 1,
	},
	{
		name: "4-MULTI-CRITERIA (two criteria in one decision)",
		decision: `Two changes confirmed: (a) defer MFA entirely — drop the TOTP
requirement; and (b) replace the emailed magic-link password reset with answering
two pre-set security questions.`,
		preserved: [
			"- AC#1: The user can log in with email and password.",
			"- AC#4: The user is locked out for 15 minutes after 5 failed attempts.",
			"- AC#5: A successful login redirects to the dashboard the user last visited.",
		],
		minPatches: 2,
	},
];

describe.skipIf(!process.env.RUN_PHASE0)(
	"PHASE 0 — LLM scoped-patch contract",
	() => {
		it.each(SCENARIOS)(
			"$name → tight patch, not a rewrite",
			async (sc) => {
				const { model } = await getAIModelWithMetadata(
					{ taskType: "COMPLEX" },
					{ userId: DEV_USER_ID, organizationId: ORG_ID },
				);

				const { object } = await generateObject({
					model,
					schema: zodSchema(SpecPatchSetSchema),
					prompt: buildSpecPatchPrompt(sc.decision, SPEC),
				});

				const { result, applied, failed } = applySpecPatches(
					SPEC,
					object.patches,
				);

				const specLines = SPEC.split("\n");
				const resultLines = result.split("\n");
				const changedLines = specLines.filter(
					(line, i) => line !== resultLines[i],
				).length;
				const touchedChars = object.patches.reduce(
					(n, p) => n + p.from.length + p.to.length,
					0,
				);

				console.log(`\n===== PHASE 0 · ${sc.name} =====`);
				console.log(`patches returned : ${object.patches.length}`);
				console.log(
					`applied / failed : ${applied.length} / ${failed.length}`,
				);
				console.log(
					`spec lines changed: ${changedLines} / ${specLines.length}`,
				);
				console.log(
					`chars in patches  : ${touchedChars} (spec is ${SPEC.length})`,
				);
				for (const p of object.patches) {
					console.log(`  • ${p.summary}`);
					console.log(`    FROM: ${JSON.stringify(p.from)}`);
					console.log(`    TO:   ${JSON.stringify(p.to)}`);
				}
				if (failed.length) {
					console.log("REFUSED (from not located verbatim):");
					for (const f of failed) {
						console.log(
							`  • ${f.reason} (matchCount=${f.matchCount}): ${JSON.stringify(f.patch.from)}`,
						);
					}
				}
				console.log(`----- RESULTING SPEC -----\n${result}\n`);

				// Safety contract: every patch must locate verbatim (the make-or-break
				// — a refusal here is the signal TG4's refuse-path must handle), the
				// edit must be genuinely scoped, and unrelated criteria untouched.
				expect(object.patches.length).toBeGreaterThanOrEqual(
					sc.minPatches,
				);
				expect(failed).toHaveLength(0);
				expect(changedLines).toBeLessThan(specLines.length / 2);
				for (const line of sc.preserved) {
					expect(result).toContain(line);
				}
			},
			60_000,
		);
	},
);
