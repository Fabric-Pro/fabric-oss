/**
 * A migration may not assume it can turn RLS off (Fizzy #2307).
 *
 * `SET LOCAL row_security = off` grants nothing. For a role that bypasses RLS it
 * is a no-op; for a role that cannot it makes the next query whose result RLS
 * would affect raise 42501, and every statement queued behind it 25P02. That asymmetry
 * is a useful alarm on a host where the bypass ATTRIBUTE is the only way to see
 * every row, and wrong on a host where it is not.
 *
 * Databricks Lakebase grants BYPASSRLS to no role at all — staging runs RLS in
 * policy mode, with permissive `app_bypass` / `worker_bypass` policies standing
 * in for the attribute (`APP_RLS_BYPASS`, scripts/apply-rls-direct.ts). An
 * unconditional guard turned the publishing-topic contract migration, which
 * would have applied cleanly there, into a failed deploy that blocked every
 * staging promotion behind it.
 *
 * CI cannot be relied on to catch the next one: db-integration.yml applies
 * migrations as `postgres`, a superuser, which bypasses FORCE ROW LEVEL
 * SECURITY by design. A migration written against the bypass attribute passes
 * there and fails only on the host that has no such attribute to offer. Hence
 * the static rule below, which needs no database and runs everywhere.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../prisma/client";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const MIGRATIONS_DIR = join(__dirname, "..", "prisma", "migrations");

/**
 * The one migration this rule cannot reach.
 *
 * `20260827120000_drop_publishing_topic_deferred_status` is the file whose
 * unconditional guard caused all of this, and it is also the reason the rule
 * exists. It is exempt because it CANNOT be corrected: production applied it
 * successfully — Neon's migration role carries the bypass attribute — and Prisma
 * stores a checksum per applied migration, so editing it would be rejected there
 * and would trade a staging blocker for a production one. The correction ships
 * as `20260827200000_drop_publishing_topic_deferred_status_policy_mode`
 * instead, which this rule does check.
 *
 * Nothing else belongs in this set. A new migration that trips the rule should
 * be fixed, not listed here — this entry is about a file that is already applied
 * and therefore immutable, not about a rule that is inconvenient.
 */
const APPLIED_AND_IMMUTABLE: ReadonlySet<string> = new Set([
	"20260827120000_drop_publishing_topic_deferred_status",
]);

function migrationsMentioningRowSecurity(): Array<{
	name: string;
	sql: string;
}> {
	return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => ({
			name: entry.name,
			path: join(MIGRATIONS_DIR, entry.name, "migration.sql"),
		}))
		.flatMap(({ name, path }) => {
			let sql: string;
			try {
				sql = readFileSync(path, "utf8");
			} catch {
				return [];
			}
			if (APPLIED_AND_IMMUTABLE.has(name)) {
				return [];
			}
			return /row_security/i.test(sql) ? [{ name, sql }] : [];
		});
}

/**
 * Walk the SQL once, tracking line comments, block comments, single-quoted
 * strings and dollar-quoted bodies. Returns TWO length-aligned views of the
 * source with comments blanked in place, plus the span of every dollar-quoted
 * body that opens a `DO` block.
 *
 * The views differ only in string literals, and that difference is the point.
 * `withStrings` keeps them, because a `SET` reached through `EXECUTE '...'` has
 * to stay visible. `withoutStrings` blanks them, because a guard's condition is
 * code — text that merely mentions `rolbypassrls` from inside a literal is not a
 * check, and judging the condition on this view is what stops a forged one from
 * passing.
 *
 * "Literal" includes the dollar-quoted kind. `EXECUTE $sql$ ... $sql$` nested
 * inside a `DO $do$ ... $do$` body is ordinary plpgsql. The outer body is read as
 * code — plpgsql is what we are trying to inspect, and `--` really is a comment
 * there — but a nested body is a STRING, and a string is opaque: inside it `--`
 * starts nothing, `'` quotes nothing, and a different `$other$` opens nothing.
 * Only its own closing tag ends it. Reading it any other way loses the closing
 * delimiter, which is how `EXECUTE $sql$ ... -- comment$sql$` would otherwise
 * swallow the rest of the block.
 *
 * Hand-rolled regex is not enough here: the rule has to hold for
 * `SET SESSION row_security`, for a line break between `SET LOCAL` and the
 * name, and for a `SET` reached through `EXECUTE`. Matching statement shapes
 * misses all three; locating the token and asking what encloses it does not.
 *
 * An opening delimiter must not be preceded by an identifier character —
 * `SELECT 1 AS left$x$tag` is a valid column alias, not the start of a
 * dollar-quoted body, and treating it as one would let an unguarded statement
 * after it look enclosed. A CLOSING delimiter has no such rule: inside a body,
 * `END$x$` does terminate it.
 */
function scan(sql: string): {
	withStrings: string;
	withoutStrings: string;
	doBlocks: Array<[number, number]>;
} {
	let withStrings = "";
	let withoutStrings = "";
	const doBlocks: Array<[number, number]> = [];
	let i = 0;
	let openedAt = -1;
	let openTag: string | null = null;
	let depth = 0;
	let isDoBlock = false;

	const blank = (ch: string) => (ch === "\n" ? "\n" : " ");
	// Whatever precedes the delimiter, ignoring whitespace, ends with DO.
	const opensADoBlock = (upto: number) =>
		/\bDO\s*$/i.test(sql.slice(Math.max(0, upto - 64), upto));

	while (i < sql.length) {
		const rest = sql.slice(i);

		// Comments are comments inside a plpgsql body too.
		if (rest.startsWith("--")) {
			while (i < sql.length && sql[i] !== "\n") {
				withStrings += " ";
				withoutStrings += " ";
				i += 1;
			}
			continue;
		}
		if (rest.startsWith("/*")) {
			const end = sql.indexOf("*/", i + 2);
			const stop = end === -1 ? sql.length : end + 2;
			for (; i < stop; i += 1) {
				withStrings += blank(sql[i] as string);
				withoutStrings += blank(sql[i] as string);
			}
			continue;
		}
		// Kept verbatim — dynamic SQL lives in strings — but consumed here so a
		// `--` inside one is not mistaken for a comment.
		if (sql[i] === "'") {
			withStrings += sql[i];
			withoutStrings += " ";
			i += 1;
			while (i < sql.length) {
				if (sql[i] === "'" && sql[i + 1] === "'") {
					withStrings += "''";
					withoutStrings += "  ";
					i += 2;
					continue;
				}
				withStrings += sql[i];
				withoutStrings += blank(sql[i] as string);
				i += 1;
				if (sql[i - 1] === "'") {
					break;
				}
			}
			continue;
		}

		const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
		const boundary = i === 0 || !/[A-Za-z0-9_$]/.test(sql[i - 1] as string);
		if (dollar && (depth > 0 || boundary)) {
			const found = dollar[1] ?? "";
			if (depth === 0) {
				openTag = found;
				openedAt = i;
				isDoBlock = opensADoBlock(i);
				depth = 1;
				withStrings += dollar[0];
				withoutStrings += dollar[0];
				i += dollar[0].length;
				continue;
			}
			if (openTag === found) {
				if (isDoBlock) {
					doBlocks.push([openedAt, i + dollar[0].length]);
				}
				depth = 0;
				openTag = null;
				openedAt = -1;
				isDoBlock = false;
				withStrings += dollar[0];
				withoutStrings += dollar[0];
				i += dollar[0].length;
				continue;
			}
			// A nested dollar-quoted STRING. Opaque: consume to its own closing
			// tag without interpreting anything in between.
			const close = sql.indexOf(dollar[0], i + dollar[0].length);
			const stop = close === -1 ? sql.length : close + dollar[0].length;
			withStrings += sql.slice(i, stop);
			for (let j = i; j < stop; j += 1) {
				withoutStrings += blank(sql[j] as string);
			}
			i = stop;
			continue;
		}

		withStrings += sql[i];
		withoutStrings += sql[i];
		i += 1;
	}

	return { withStrings, withoutStrings, doBlocks };
}

/**
 * Spans of every `IF <capability condition> THEN ... END IF` body in `code`.
 *
 * Containment inside the DO block is not enough: a block holding an unrelated
 * capability check followed by an UNCONDITIONAL write reads as guarded and is
 * not. What has to hold is control dependence — the write must sit in the body
 * the condition governs — so this returns those bodies and the caller requires
 * each `row_security` write to fall inside one.
 *
 * Walked as an ordered token stream rather than with a lookbehind. `END IF`
 * is one token, so the `IF` inside it can never be mistaken for an opening one,
 * however much blanked-out comment sits between the two words — a fixed-width
 * backward window gets `END /* ... *\/ IF` wrong once the comment is longer than
 * the window.
 *
 * A top-level `ELSE` **or `ELSIF`** disqualifies the body: on either branch the
 * write may be the one taken when the role CANNOT bypass, and this rule cannot
 * tell which. Conservative on purpose — an unusual but safe guard fails and gets
 * rewritten, where the reverse would ship the bug.
 */
function capabilityGuardedBodies(code: string): Array<[number, number]> {
	const bodies: Array<[number, number]> = [];
	interface Frame {
		guards: boolean;
		condFrom: number;
		bodyFrom: number;
		branched: boolean;
	}
	const stack: Frame[] = [];

	for (const token of code.matchAll(
		/\bEND\s+IF\b|\bELSIF\b|\bELSE\b|\bTHEN\b|\bIF\b/gi,
	)) {
		const at = token.index ?? 0;
		const word = token[0].replace(/\s+/g, " ").toUpperCase();

		if (word === "IF") {
			stack.push({
				guards: false,
				condFrom: at,
				bodyFrom: -1,
				branched: false,
			});
			continue;
		}
		const top = stack[stack.length - 1];
		if (!top) {
			continue;
		}
		if (word === "THEN") {
			if (top.bodyFrom === -1) {
				const condition = code.slice(top.condFrom, at);
				top.guards =
					/rolbypassrls/i.test(condition) &&
					/current_user/i.test(condition) &&
					!/pg_has_role/i.test(condition);
				top.bodyFrom = at + token[0].length;
			}
			continue;
		}
		if (word === "ELSE" || word === "ELSIF") {
			top.branched = true;
			continue;
		}
		// END IF
		stack.pop();
		if (top.guards && !top.branched && top.bodyFrom !== -1) {
			bodies.push([top.bodyFrom, at]);
		}
	}

	return bodies;
}

describe("migrations must not assume an RLS bypass attribute", () => {
	it("puts every `row_security` write behind a capability check", () => {
		for (const { name, sql } of migrationsMentioningRowSecurity()) {
			const { withStrings, withoutStrings, doBlocks } = scan(sql);

			for (const match of withStrings.matchAll(/row_security/gi)) {
				const at = match.index ?? 0;
				const enclosing = doBlocks.find(
					([start, end]) => at >= start && at < end,
				);

				expect(
					enclosing,
					`${name} writes row_security outside a DO block, so it runs unconditionally. On a host where no role can hold BYPASSRLS (Databricks Lakebase) that raises 42501 on the next RLS-affected query and aborts the migration. Wrap it in a DO block that fires only when pg_roles reports rolsuper or rolbypassrls for current_user — see 20260827200000_drop_publishing_topic_deferred_status_policy_mode.`,
				).toBeDefined();

				// Judged on the string-free view: a condition is code, not text.
				const body = withoutStrings.slice(
					enclosing?.[0] ?? 0,
					enclosing?.[1] ?? 0,
				);

				expect(
					body,
					`${name} touches row_security inside a DO block that never consults rolbypassrls.`,
				).toMatch(/rolbypassrls/i);

				// Reading the attribute off some other role would not answer the
				// question the guard asks.
				expect(
					body,
					`${name} checks rolbypassrls without tying it to current_user.`,
				).toMatch(/current_user/i);

				// BYPASSRLS is not conferred by role membership: a role inheriting
				// from a BYPASSRLS role still raises 42501. A membership-aware
				// condition therefore reads as a capability check and is not one.
				expect(
					body,
					`${name} decides the row_security guard from role membership. BYPASSRLS is not inherited — a role that inherits it still cannot bypass — so this reintroduces the bug it looks like it prevents. Read rolsuper/rolbypassrls off the role itself.`,
				).not.toMatch(/pg_has_role/i);

				// And the write must be governed BY that condition, not merely
				// keep it company inside the same block.
				const start = enclosing?.[0] ?? 0;
				const guarded = capabilityGuardedBodies(body).some(
					([from, to]) => at - start >= from && at - start < to,
				);
				expect(
					guarded,
					`${name} writes row_security inside a DO block that does contain a capability check, but the write is not inside the branch that check governs — so it runs unconditionally anyway.`,
				).toBe(true);
			}
		}
	});

	it("still covers the migration this rule was written for", () => {
		const names = migrationsMentioningRowSecurity().map((m) => m.name);
		expect(names).toContain(
			"20260827200000_drop_publishing_topic_deferred_status_policy_mode",
		);
	});
});

// The behavioural half. `SET LOCAL ROLE` reproduces a non-superuser's RLS
// treatment on the superuser connection the suite already has, so this needs no
// second DATABASE_URL — but it does need a role, so it degrades to skipped
// rather than failing where the test connection cannot create one.
const RUN_ID = `${process.pid}${Date.now().toString(36)}`;
const PROBE_TABLE = `rls_guard_probe_${RUN_ID}`;
const PROBE_TYPE = `rls_guard_probe_status_${RUN_ID}`;
const PROBE_ROLE = `rls_guard_probe_role_${RUN_ID}`;

/**
 * `permission denied`, `must be superuser`, and 42501 are the shapes a
 * connection without CREATEROLE produces. Everything else is a real failure.
 */
function isPrivilegeError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /permission denied|must be superuser|must have CREATEROLE|42501/i.test(
		message,
	);
}

function capabilityGuardFrom(migration: string): string {
	const sql = readFileSync(
		join(MIGRATIONS_DIR, migration, "migration.sql"),
		"utf8",
	);
	// Just the capability check, not the whole block around it: the corrective
	// migration's DO block also locks and rewrites `publishing_topic`, which does
	// not exist on the probe. Extracting rather than restating the condition is
	// the point — change the guard in the migration and these tests execute the
	// changed one.
	const guard = /IF \(\s*SELECT rolsuper OR rolbypassrls[\s\S]*?END IF;/.exec(
		sql,
	);
	if (!guard) {
		throw new Error(`no capability guard found in ${migration}`);
	}
	return `DO $probe$\nBEGIN\n${guard[0]}\nEND\n$probe$;`;
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"the capability guard, executed",
	() => {
		let ready = false;

		beforeAll(async () => {
			try {
				await db.$executeRawUnsafe(
					`CREATE ROLE "${PROBE_ROLE}" NOSUPERUSER NOBYPASSRLS`,
				);
				await db.$executeRawUnsafe(
					`CREATE TYPE "${PROBE_TYPE}" AS ENUM ('SUGGESTION', 'DEFERRED')`,
				);
				await db.$executeRawUnsafe(
					`CREATE TABLE "${PROBE_TABLE}" (id text PRIMARY KEY, "organizationId" text, status "${PROBE_TYPE}" NOT NULL)`,
				);
				await db.$executeRawUnsafe(
					`INSERT INTO "${PROBE_TABLE}" VALUES ('a','org1','DEFERRED'), ('b','org2','DEFERRED')`,
				);
				await db.$executeRawUnsafe(
					`ALTER TABLE "${PROBE_TABLE}" ENABLE ROW LEVEL SECURITY`,
				);
				await db.$executeRawUnsafe(
					`ALTER TABLE "${PROBE_TABLE}" FORCE ROW LEVEL SECURITY`,
				);
				// The production shape: no tenant context means no rows.
				await db.$executeRawUnsafe(
					`CREATE POLICY tenant_isolation ON "${PROBE_TABLE}" FOR ALL USING (CASE WHEN current_setting('app.tenant_id', true) IS NOT NULL THEN "organizationId" = current_setting('app.tenant_id', true) ELSE false END)`,
				);
				// The Lakebase shape: a permissive policy standing in for BYPASSRLS.
				await db.$executeRawUnsafe(
					`CREATE POLICY app_bypass ON "${PROBE_TABLE}" FOR ALL TO "${PROBE_ROLE}" USING (true) WITH CHECK (true)`,
				);
				await db.$executeRawUnsafe(
					`GRANT ALL ON "${PROBE_TABLE}" TO "${PROBE_ROLE}"`,
				);
				ready = true;
			} catch (error) {
				// A connection without CREATEROLE cannot set this up, and that is a
				// legitimate skip. Anything else is a real failure and must not
				// disappear into one: a swallowed error here would silently delete
				// the coverage this file exists to provide.
				if (!isPrivilegeError(error)) {
					throw error;
				}
				ready = false;
			}
		});

		// Unconditional: setup can fail PART WAY through, so `ready` being false is
		// not evidence that there is nothing to drop.
		afterAll(async () => {
			await db
				.$executeRawUnsafe(`DROP TABLE IF EXISTS "${PROBE_TABLE}"`)
				.catch(() => {});
			await db
				.$executeRawUnsafe(`DROP TYPE IF EXISTS "${PROBE_TYPE}"`)
				.catch(() => {});
			await db
				.$executeRawUnsafe(`DROP ROLE IF EXISTS "${PROBE_ROLE}"`)
				.catch(() => {});
		});

		it("stands down for a role with no bypass attribute, so the drain runs", async (ctx) => {
			if (!ready) {
				ctx.skip();
			}
			const guard = capabilityGuardFrom(
				"20260827200000_drop_publishing_topic_deferred_status_policy_mode",
			);
			// Re-seed on the superuser connection so the assertion below does not
			// depend on this file's test order.
			await db.$executeRawUnsafe(
				`UPDATE "${PROBE_TABLE}" SET status = 'DEFERRED'`,
			);

			const drained = await db.$transaction(async (tx) => {
				await tx.$executeRawUnsafe(`SET LOCAL ROLE "${PROBE_ROLE}"`);
				await tx.$executeRawUnsafe(guard);
				// Unguarded, this statement is where 42501 lands.
				return tx.$executeRawUnsafe(
					`UPDATE "${PROBE_TABLE}" SET status = 'SUGGESTION' WHERE status = 'DEFERRED'`,
				);
			});

			expect(drained).toBe(2);
		});

		it("leaves row_security on for that role, and turns it off for one that can bypass", async (ctx) => {
			if (!ready) {
				ctx.skip();
			}
			const guard = capabilityGuardFrom(
				"20260827200000_drop_publishing_topic_deferred_status_policy_mode",
			);

			const asProbeRole = await db.$transaction(async (tx) => {
				await tx.$executeRawUnsafe(`SET LOCAL ROLE "${PROBE_ROLE}"`);
				await tx.$executeRawUnsafe(guard);
				return tx.$queryRawUnsafe<Array<{ row_security: string }>>(
					"SELECT current_setting('row_security') AS row_security",
				);
			});
			expect(asProbeRole[0]?.row_security).toBe("on");

			// The test connection is the superuser one, which does bypass.
			const asBypassingRole = await db.$transaction(async (tx) => {
				await tx.$executeRawUnsafe(guard);
				return tx.$queryRawUnsafe<Array<{ row_security: string }>>(
					"SELECT current_setting('row_security') AS row_security",
				);
			});
			expect(asBypassingRole[0]?.row_security).toBe("off");
		});
	},
);
