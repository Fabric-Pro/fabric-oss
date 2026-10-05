/**
 * Ratchet: no NEW procedure may resolve the organization from caller input
 * without verifying membership of that organization.
 *
 * Why this exists alongside `input-org-authorization-guard.test.ts`: that guard
 * only inspects WRITES, and it accepts `requireProjectPermission(` and
 * `hasProjectAccess(` as evidence of org authorization. `hasProjectAccess`
 * declares its third parameter `_organizationId` and ignores it, and a
 * project permission check says nothing about an organization-level procedure.
 *
 * ROOT ENFORCEMENT FOR PROJECT-SCOPED PROCEDURES. Since Fizzy #2904,
 * `assertProjectPermission` — behind `requireProjectPermission` and the
 * handler-side checks — records the authorized project's organization for the
 * request (`lib/authorized-project-binding.ts`), and `resolveOrganizationId`,
 * its mirror in `require-permission.ts` and `resolveOrganizationIdForCaller`
 * refuse a different input organization and default to the project's. So a
 * project-scoped procedure that authorizes the project BEFORE it resolves the
 * organization no longer trusts the input.
 *
 * WHY THAT IS NOT FILE-LEVEL CREDIT HERE. A token match cannot tell which
 * procedure in a file the check guards, whether it runs before or after the
 * resolution (the weave procedures resolve first and authorize later), or
 * whether the handler also reads `input.organizationId` somewhere the resolver
 * never sees. The root enforcement makes these files safer; it does not audit
 * them. So `requireProjectPermission` still earns nothing below, and the
 * baseline shrinks only by files fixed one at a time. Handlers that read the
 * input organization WITHOUT a resolver are policed by the sibling
 * `input-org-raw-consumer-ratchet.test.ts`.
 *
 * That combination shipped a cross-tenant read in the roadmap's open-decisions
 * endpoint (fixed 2026-07-21). The guard was green throughout, because the
 * endpoint is a read and because it called `hasProjectAccess`.
 *
 * The baseline is a ledger, and anything NOT on it fails. Entries may only be
 * REMOVED (by fixing the file), never added. Each needs
 * `requireInputOrgPermission` with the right permission, the organization
 * derived from the loaded record, or a documented reason it is safe.
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

/**
 * Resolves the org FROM caller input — the unverified source.
 * `resolveSourceCredentialOrganizationId` keeps the pre-binding precedence for
 * selecting the caller's own connection, so it returns a caller-named
 * organization just as unverified and is matched too.
 */
const INPUT_ORG_RE =
	/(resolveOrganizationId|resolveSourceCredentialOrganizationId)\(\s*input\??\.organizationId/;

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
