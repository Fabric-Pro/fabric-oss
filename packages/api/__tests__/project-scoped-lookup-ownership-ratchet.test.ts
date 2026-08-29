/**
 * Ratchet: a procedure already gated by `requireProjectPermission` must not
 * ALSO scope its own project lookup to the caller as owner.
 *
 * `requireProjectPermission` is the authoritative gate. It resolves
 * `(projectId, userId)` through `resolveEffectiveProjectPermissions`, whose
 * precedence is A -> C -> B:
 *
 *   A. personal-project owner
 *   C. an active (accepted, non-expired) ProjectMember row — authoritative
 *   B. otherwise the caller's org role on the project's host organization
 *
 * A handler that then re-derives the project with
 * `{ id, organizationId: null, userId: context.user.id }` silently drops paths
 * C and B. In personal context that clause means *owner*, so an accepted
 * project member — including an external guest — passes the middleware and is
 * then rejected by the handler with `NOT_FOUND`. That shipped as a real defect
 * in the newsletter and daily-brief modules: every procedure 404'd for a
 * non-owner member of a personal project, and because the READ failed silently
 * the settings panel rendered its defaults instead of an error, which reads as
 * "not configured" rather than "no access".
 *
 * The fix is the pattern in
 * `projects/procedures/publishing-suite/get-settings.ts`: let the middleware
 * authorize, then load the project by id alone and take the tenant from the
 * loaded row. `input.organizationId` is a guard, never a scoping key.
 *
 * Do NOT "fix" a violation by swapping in `getProjectAccessById` /
 * `buildProjectAccessWhere`. Those require `userId` OR a ProjectMember row and
 * so have no path B — they would 404 an org-role caller who legitimately holds
 * permission without a member row. They are for procedures that do their own
 * authorization, not for ones already behind this middleware.
 */

import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../../..");
const modulesRoot = resolve(repoRoot, "packages/api/modules");

/** The procedure is behind the authoritative project gate. */
const PROJECT_GATED_RE = /requireProjectPermission\s*\(/;

/** It nonetheless loads the project itself... */
const PROJECT_LOOKUP_RE = /db\.project\.find(?:First|Unique)\s*\(/g;

/** ...and constrains that load to the caller as owner. */
const OWNER_SCOPED_RE = /userId:\s*context\.user\.id/;

/**
 * Read the balanced `(...)` that follows `index`, so the owner test applies to
 * the project lookup's OWN argument and nothing else.
 *
 * Matching `userId: context.user.id` anywhere in the file is not good enough:
 * `project-tabs.ts` and `stories/maturation/get-editor-state.ts` both load a
 * project AND, in a separate query, a per-user row that is legitimately keyed
 * by the caller. A file-wide regex flags those as violations, and a ratchet
 * that cries wolf is one the next person deletes.
 */
function argumentTextAt(content: string, index: number): string {
	const open = content.indexOf("(", index);
	if (open === -1) {
		return "";
	}
	let depth = 0;
	for (let i = open; i < content.length; i++) {
		const ch = content[i];
		if (ch === "(") {
			depth++;
		} else if (ch === ")") {
			depth--;
			if (depth === 0) {
				return content.slice(open, i + 1);
			}
		}
	}
	return content.slice(open);
}

function hasOwnerScopedProjectLookup(content: string): boolean {
	PROJECT_LOOKUP_RE.lastIndex = 0;
	let match = PROJECT_LOOKUP_RE.exec(content);
	while (match !== null) {
		if (OWNER_SCOPED_RE.test(argumentTextAt(content, match.index))) {
			return true;
		}
		match = PROJECT_LOOKUP_RE.exec(content);
	}
	return false;
}

/**
 * Deliberately empty. Every project-gated procedure in the repo now loads its
 * project by id alone; there is no legacy debt to carry.
 *
 * Kept (with its honesty test below) because the ratchet's value is in what it
 * blocks next, and the first person who needs an exception should have to add
 * themselves to a named list with a reason rather than relax the rule.
 */
const KNOWN_UNFIXED: readonly string[] = [];

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

function ownerScopedProjectGatedFiles(): string[] {
	const out: string[] = [];
	for (const absFile of findProcedureFiles(modulesRoot)) {
		const content = readFileSync(absFile, "utf-8");
		if (
			PROJECT_GATED_RE.test(content) &&
			hasOwnerScopedProjectLookup(content)
		) {
			out.push(relative(repoRoot, absFile).split(sep).join("/"));
		}
	}
	return out.sort();
}

describe("project-scoped lookup ownership ratchet", () => {
	it("no procedure behind requireProjectPermission re-scopes its project lookup to the caller as owner", () => {
		const known = new Set(KNOWN_UNFIXED);
		const violations = ownerScopedProjectGatedFiles().filter(
			(file) => !known.has(file),
		);

		expect(
			violations,
			"These procedures are already authorized by `requireProjectPermission`, then load the\n" +
				"project again scoped to `userId: context.user.id`. In personal context that means OWNER,\n" +
				"so an accepted ProjectMember (including an external guest) is authorized by the middleware\n" +
				"and then rejected here with NOT_FOUND.\n\n" +
				"Load the project by id alone and derive the tenant from the loaded row; treat\n" +
				"`input.organizationId` as a guard, not a scoping key. See\n" +
				"projects/procedures/publishing-suite/get-settings.ts.\n\n" +
				"Do NOT substitute getProjectAccessById/buildProjectAccessWhere — they have no org-role\n" +
				"path and would 404 a legitimate org-role caller.\n\n" +
				violations.map((f) => `  - ${f}`).join("\n"),
		).toEqual([]);
	});

	it("keeps the allowlist honest — entries that no longer match are removed", () => {
		// Same reasoning as input-org-unverified-ratchet.ts: a list that rots into
		// deleted-or-already-fixed paths would hide a genuine regression if one
		// came back under the same path.
		const current = new Set(ownerScopedProjectGatedFiles());
		const stale = KNOWN_UNFIXED.filter((f) => !current.has(f));

		expect(
			stale,
			"These files are on KNOWN_UNFIXED but no longer match — they were fixed or removed.\n" +
				"Delete them from the list:\n\n" +
				stale.map((f) => `  - ${f}`).join("\n"),
		).toEqual([]);
	});
});
