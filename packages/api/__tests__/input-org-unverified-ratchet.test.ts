/**
 * Ratchet: no NEW procedure may resolve the organization from caller input
 * without verifying membership of that organization.
 *
 * Why this exists alongside `input-org-authorization-guard.test.ts`: that guard
 * only inspects WRITES, and it accepts `requireProjectPermission(` and
 * `hasProjectAccess(` as evidence of org authorization. Neither validates the
 * input org — `requireProjectPermission` resolves on (projectId, userId) and
 * never reads the org, and `hasProjectAccess` declares its third parameter
 * `_organizationId` and ignores it. `resolveOrganizationId` returns
 * `input.organizationId` verbatim with no membership lookup, so a caller can
 * pair a project they legitimately reach with an organization they do not.
 *
 * That combination shipped a cross-tenant read in the roadmap's open-decisions
 * endpoint (fixed 2026-07-21). The guard was green throughout, because the
 * endpoint is a read and because it called `hasProjectAccess`.
 *
 * 352 files already match the risky shape. Fixing them is a large, separate
 * piece of work — each needs `requireInputOrgPermission` with the right
 * permission, or a documented reason it is safe. Until then this test freezes
 * the debt: the baseline is a ledger, and anything NOT on it fails. Entries may
 * only be REMOVED (by fixing the file), never added.
 *
 * Being on the baseline is not a statement that a file is safe. It means the
 * file predates the ratchet and has not been audited.
 */

import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

import baseline from "./input-org-unverified-baseline.json";

const repoRoot = resolve(__dirname, "../../..");
const modulesRoot = resolve(repoRoot, "packages/api/modules");

/** Resolves the org FROM caller input — the unverified source. */
const INPUT_ORG_RE = /resolveOrganizationId\(\s*input\.organizationId/;

/**
 * Tokens that actually verify membership of the TARGET organization. Deliberately
 * excludes `requireProjectPermission` / `hasProjectAccess`: both authorize a
 * project and neither looks at the org, which is exactly how the open-decisions
 * leak passed review.
 */
const ORG_VERIFIED_RE =
	/\b(requireInputOrgPermission|requireOrganizationMembership|requireOrganizationAdmin|verifyOrganizationMembership|requireOrgMembership|getOrganizationMembership)\s*\(/;

function findProcedureFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = resolve(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...findProcedureFiles(full));
			continue;
		}
		if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
			continue;
		}
		if (
			!dir.includes(`${sep}procedures${sep}`) &&
			!dir.endsWith("procedures")
		) {
			continue;
		}
		out.push(full);
	}
	return out;
}

function unverifiedFiles(): string[] {
	const found: string[] = [];
	for (const absFile of findProcedureFiles(modulesRoot)) {
		const content = readFileSync(absFile, "utf-8");
		if (!INPUT_ORG_RE.test(content)) {
			continue;
		}
		if (ORG_VERIFIED_RE.test(content)) {
			continue;
		}
		found.push(relative(repoRoot, absFile).split(sep).join("/"));
	}
	return found.sort();
}

describe("input-org verification ratchet (SOC 2 CC6.1/CC6.3)", () => {
	it("introduces no new procedure that trusts the caller-supplied organization", () => {
		const known = new Set(baseline as string[]);
		const added = unverifiedFiles().filter((file) => !known.has(file));

		expect(
			added,
			"These procedures resolve the organization from caller input without verifying membership of it.\n" +
				`\`resolveOrganizationId(input.organizationId, ...)\` returns the client's string as-is, and\n` +
				"`requireProjectPermission` / `hasProjectAccess` do NOT check the org — so a caller can pair\n" +
				`their own project with someone else's organization id.\n\n` +
				"Add `.use(requireInputOrgPermission(Permissions.<PERMISSION>))` to each, or derive the org from\n" +
				"the loaded record instead of the input.\n\n" +
				"Do NOT add these to input-org-unverified-baseline.json — that ledger only shrinks.\n\n" +
				added.map((f) => `  - ${f}`).join("\n"),
		).toEqual([]);
	});

	it("keeps the baseline honest — entries that no longer match are removed", () => {
		// Prevents the ledger rotting into a list of files that were deleted or
		// already fixed, which would hide a genuine regression if one came back
		// under the same path.
		const current = new Set(unverifiedFiles());
		const stale = (baseline as string[]).filter((f) => !current.has(f));

		expect(
			stale,
			"These files are on the unverified baseline but no longer match — they were fixed or removed.\n" +
				"Delete them from input-org-unverified-baseline.json:\n\n" +
				stale.map((f) => `  - ${f}`).join("\n"),
		).toEqual([]);
	});
});
