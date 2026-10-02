/**
 * The version of the rule set that decides whether a file may enter a
 * snapshot: every secret content rule and every secret filename rule.
 *
 * A snapshot records the version that cleared all of its files
 * (`ProjectInstructionSnapshot.scanRulesVersion`). A derived snapshot reads an
 * inherited file again only when its source was cleared under a DIFFERENT
 * version, so tightening any rule re-scans every inherited file exactly once
 * and leaves a one-file edit costing one file the rest of the time.
 *
 * Kept out of the package barrel for the reason `proposal-branch-ref.ts` is:
 * it hashes with `node:crypto`, and browser code imports the barrel.
 *
 * Two inputs make the version:
 *  - a sha256 over a stable serialization of the rules themselves (ids, regex
 *    source and flags, the parameters of the hand-written matchers, and the
 *    filename patterns), so editing a rule changes it without anyone
 *    remembering to; and
 *  - `SCANNER_REVISION`, bumped by hand for a change to a hand-written
 *    matcher's LOGIC that no serialized parameter reflects.
 */
import { createHash } from "node:crypto";
import {
	SECRET_FILE_PATTERNS,
	SECRET_RULES,
	SECRET_SCANNER_PARAMETERS,
} from "./secrets";

/** Bump when a matcher's code changes in a way its serialized rule does not show. */
export const SCANNER_REVISION = 1;

type ScanRuleSet = {
	contentRules: ReadonlyArray<{ id: string; signature: string }>;
	filenamePatterns: readonly string[];
	parameters: unknown;
	revision: number;
};

/** The version of `ruleSet`; exported for the test that proves it follows the rules. */
export function computeScanRulesVersion(ruleSet: ScanRuleSet): string {
	const serialized = JSON.stringify([
		ruleSet.revision,
		ruleSet.contentRules.map((rule) => [rule.id, rule.signature]),
		ruleSet.filenamePatterns,
		ruleSet.parameters,
	]);
	return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
}

export const INSTRUCTION_SCAN_RULES_VERSION = computeScanRulesVersion({
	contentRules: SECRET_RULES,
	filenamePatterns: SECRET_FILE_PATTERNS,
	parameters: SECRET_SCANNER_PARAMETERS,
	revision: SCANNER_REVISION,
});
