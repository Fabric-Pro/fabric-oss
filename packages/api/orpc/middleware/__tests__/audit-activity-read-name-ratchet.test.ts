/**
 * Repository-wide ratchet for the activity-capture read-name rule.
 *
 * `shouldCapture` drops a non-GET call when the procedure is named like a read.
 * A name is normally a weak signal, and relying on one would be the same
 * verb-guessing the rule replaced — so this test checks it against every
 * procedure in the repository instead of trusting it.
 *
 * **The invariant: no procedure whose name matches the read pattern may contain
 * a write call.** If one does, its mutations are silently missing from the audit
 * ledger, and a missing audit record cannot be recovered later.
 *
 * Two ways to fix a failure, both fine:
 *   1. Rename the procedure so it does not read as a read (`getOrCreateThing` →
 *      `ensureThing`).
 *   2. Declare the exception: `.meta({ auditActivity: "always" })`, which
 *      overrides the inference. This test accepts that as the remedy.
 *
 * Do NOT fix a failure by loosening the pattern or adding the file to an
 * ignore list. A red ratchet means real events are about to stop being recorded.
 *
 * Scope note: this reads source text, so it cannot see a write reached through a
 * helper in another file. It is a floor, not a proof — but it is the floor that
 * catches the realistic case, and it caught four `cancel*` procedures being
 * classified as reads while this rule was being written (`can` matched `cancel`
 * before the pattern required a camelCase boundary).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { hasReadShapedName } from "../audit-activity-middleware";

const MODULES_ROOT = resolve(__dirname, "../../../modules");

/**
 * Prisma operations that change data, as they appear in source. `$transaction`
 * counts: it is only used here to group writes.
 */
const WRITE_CALL =
	/\.(?:create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\s*\(|\$executeRaw|\$transaction/;

function listSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "__tests__") out.push(...listSourceFiles(full));
		} else if (entry.name.endsWith(".ts")) {
			out.push(full);
		}
	}
	return out;
}

interface Procedure {
	name: string;
	file: string;
	body: string;
	declaredMethod: string | undefined;
	declaresAlwaysCapture: boolean;
}

function collectProcedures(): Procedure[] {
	const procedures: Procedure[] = [];
	for (const file of listSourceFiles(MODULES_ROOT)) {
		const source = readFileSync(file, "utf8");
		const exportPattern =
			/export const (\w+)\s*=\s*([\s\S]*?)(?=\nexport const |$)/g;
		let match = exportPattern.exec(source);
		while (match) {
			const [, name, body] = match;
			if (name && body && /\.handler\(/.test(body)) {
				const methodMatch = body.match(/method:\s*"(\w+)"/);
				procedures.push({
					name,
					file: file.split(sep).join("/"),
					body,
					declaredMethod: methodMatch?.[1],
					declaresAlwaysCapture: /auditActivity:\s*"always"/.test(
						body,
					),
				});
			}
			match = exportPattern.exec(source);
		}
	}
	return procedures;
}

/**
 * The middleware sees a procedure PATH and tests its leaf. Here the leaf is the
 * export name minus the repo's `...Procedure` suffix, which is how router keys
 * are derived.
 */
function leafName(exportName: string): string {
	return exportName.replace(/Procedure$/, "");
}

const procedures = collectProcedures();

describe("activity-capture read-name ratchet", () => {
	it("finds the procedures to check at all", () => {
		// Guards against the scan silently matching nothing — a regex that finds
		// zero procedures would make every assertion below vacuously true. This
		// is the failure mode that makes a green ratchet meaningless.
		expect(procedures.length).toBeGreaterThan(500);
	});

	it("no read-named non-GET procedure contains a write call", () => {
		const offenders = procedures
			.filter((p) => p.declaredMethod !== "GET")
			.filter((p) => hasReadShapedName([leafName(p.name)]))
			.filter((p) => !p.declaresAlwaysCapture)
			.filter((p) => WRITE_CALL.test(p.body))
			.map((p) => `${p.name}  (${p.file})`);

		expect(offenders).toEqual([]);
	});

	it("still classifies a meaningful number of procedures as reads", () => {
		// The rule only earns its keep if it drops real volume. If a future
		// pattern edit narrowed this to near zero, capture would quietly revert
		// to the old verb-only behaviour and nothing else would notice.
		const readNamed = procedures
			.filter((p) => p.declaredMethod !== "GET")
			.filter((p) => hasReadShapedName([leafName(p.name)]));

		expect(readNamed.length).toBeGreaterThan(50);
	});
});
