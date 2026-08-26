import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * FR7 regression guard.
 *
 * A source-level assertion rather than a behavioral one, deliberately: it
 * catches persistence routes a behavioral test would miss — Prisma writes,
 * Redis, Temporal, embeddings — including ones added inside a branch no
 * behavioral test happens to exercise.
 *
 * CAVEAT: the forbidden-import list is a deny-list, so a persistence mechanism
 * nobody has thought of yet (lru-cache, @vercel/kv, fs.writeFile, a POST to an
 * internal cache service) is invisible to it. This guard raises the cost of an
 * accident; it is not a proof of absence. Add new names as they appear.
 *
 * If this fails, do not "fix the test". Re-read
 * docs/superpowers/specs/2026-07-21-meeting-digest-personal-meetings-design.md.
 */

// vitest runs from apps/web.
const PROCEDURE_DIR = resolve(
	process.cwd(),
	"../../packages/api/modules/projects/procedures/meeting-digest",
);

const PERSONAL_PROCEDURES = [
	"list-personal-meetings.ts",
	"get-personal-transcript.ts",
	// Summarises the transcript in-request and returns it without storing it.
	"get-personal-insights.ts",
	// The Graph read itself, shared by the transcript and insights procedures.
	// Guarded in its own right: it is where the transcript text actually
	// materialises, so a persistence edit here would leak for both callers.
	"personal-transcript-fetch.ts",
	// Pure string helper, no imports today — included so a future edit that
	// adds persistence (e.g. "just log the failure") trips this guard too.
	"microsoft-connection-error.ts",
] as const;

// Deliberately NOT anchored to the literal identifier `db`. This repo's own
// tenant-isolation helper is used as `const tenantDb = getTenantDb()`, and its
// JSDoc shows `tenantDb.mCPConfig.findMany()` — so an engineer reaching for
// "the tenant-safe way to write" would sail straight past a /\bdb\./ guard
// while believing they were following best practice. Match any receiver.
const WRITE_CALL =
	/\b\w+\.\w+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/;
const TRANSACTION = /\b\w+\.\$transaction\b/;
const FORBIDDEN_IMPORTS = [
	"@repo/temporal",
	"meetings-cache",
	"redis-cache",
	"ioredis",
	"@upstash/redis",
	"qdrant",
];

describe.each(PERSONAL_PROCEDURES)("%s persists nothing", (filename) => {
	const source = readFileSync(resolve(PROCEDURE_DIR, filename), "utf8");

	it("makes no Prisma write call", () => {
		expect(source).not.toMatch(WRITE_CALL);
	});

	it("opens no transaction", () => {
		expect(source).not.toMatch(TRANSACTION);
	});

	it.each(FORBIDDEN_IMPORTS)("does not import %s", (mod) => {
		expect(source).not.toContain(mod);
	});

	it("never reads a userId from procedure input", () => {
		// FR4/AC5: acting as another user must be unrepresentable, not merely
		// guarded. The caller's id always comes from the session.
		expect(source).not.toMatch(/input\.userId/);
	});
});

describe("listPersonalMeetings database access", () => {
	/**
	 * Every database call this procedure is allowed to make, in source order.
	 *
	 * The list is exact on purpose: this lane's promise is that looking at your
	 * own calendar leaves no trace, and the cheapest way to break that is for a
	 * later change to quietly add a query nobody weighed. Both entries below are
	 * project-scoped reads — neither records that a user looked at anything, and
	 * neither writes.
	 *
	 *  - `projectLinkedMeeting.findMany` — which of the caller's meetings the
	 *    project already renders in the team view (DEF-0 suppression).
	 *  - `projectContext.findMany` — which occurrences the project already holds
	 *    an imported copy of (#2170). The sheet's privacy notice depends on it:
	 *    component state alone dies on reload and the notice reverts to calling
	 *    a stored, project-visible transcript private.
	 *
	 * Adding a third means re-reading the guarantee in
	 * `docs/superpowers/specs` before adding a line here.
	 */
	const ALLOWED_DB_CALLS = [
		"db.projectLinkedMeeting.findMany",
		"db.projectContext.findMany",
	];

	it("reads only what it is allowed to, and nothing else", () => {
		const source = readFileSync(
			resolve(PROCEDURE_DIR, "list-personal-meetings.ts"),
			"utf8",
		);
		// `\w*[dD]b` catches `db`, `tenantDb`, `readDb`… but not unrelated
		// chains like `input.from.toISOString`, which a bare `\w+\.\w+\.\w+`
		// would sweep up and break the exact-match assertion below.
		const dbCalls = source.match(/\b\w*[dD]b\.\w+\.\w+/g) ?? [];
		expect(dbCalls).toEqual(ALLOWED_DB_CALLS);
	});

	// The write ban above is source-level for every procedure in the lane; this
	// pins the specific shape of the one read that was added latest, so a future
	// edit cannot widen it into a scan of somebody else's contexts.
	it("scopes the imported-context read to this project", () => {
		const source = readFileSync(
			resolve(PROCEDURE_DIR, "list-personal-meetings.ts"),
			"utf8",
		);
		const query = source.slice(
			source.indexOf("db.projectContext.findMany"),
		);
		expect(query).toMatch(/projectId: input\.projectId/);
		expect(query).toMatch(/select: \{ metadata: true \}/);
	});
});

describe("getPersonalTranscript database access", () => {
	it("touches the database at all", () => {
		const source = readFileSync(
			resolve(PROCEDURE_DIR, "get-personal-transcript.ts"),
			"utf8",
		);
		expect(source.match(/\b\w*[dD]b\.\w+\.\w+/g)).toBeNull();
	});
});

describe("audit-error middleware skip list (#1899)", () => {
	// `auditErrorMiddleware` is the outermost wrapper on every oRPC
	// procedure (packages/api/orpc/procedures.ts), and on any thrown
	// value it writes an audit row into the project's ORG tenant. Both
	// personal-meetings procedures must be hardcoded into its
	// ALWAYS_SKIP_PATHS so an env/ConfigMap drift cannot re-enable that
	// leak. This is a source-level guard, in the same spirit as the
	// persistence checks above, so this protection cannot be silently
	// deleted or narrowed without failing CI.
	const middlewareSource = readFileSync(
		resolve(
			process.cwd(),
			"../../packages/api/orpc/middleware/audit-error-middleware.ts",
		),
		"utf8",
	);

	it("hardcodes listPersonalMeetings in ALWAYS_SKIP_PATHS", () => {
		expect(middlewareSource).toMatch(
			/ALWAYS_SKIP_PATHS\s*=\s*\[[^\]]*"projects\.meetingDigest\.listPersonalMeetings"/s,
		);
	});

	it("hardcodes getPersonalTranscript in ALWAYS_SKIP_PATHS", () => {
		expect(middlewareSource).toMatch(
			/ALWAYS_SKIP_PATHS\s*=\s*\[[^\]]*"projects\.meetingDigest\.getPersonalTranscript"/s,
		);
	});

	// This one carries strictly more than the others: on the throwing path its
	// input holds the join URL, and the procedure has just had the transcript
	// in memory. An audit row for it would land in the project's ORG tenant.
	it("hardcodes getPersonalInsights in ALWAYS_SKIP_PATHS", () => {
		expect(middlewareSource).toMatch(
			/ALWAYS_SKIP_PATHS\s*=\s*\[[^\]]*"projects\.meetingDigest\.getPersonalInsights"/s,
		);
	});
});

describe("personal insights never reaches the team persistence pipeline", () => {
	const source = readFileSync(
		resolve(PROCEDURE_DIR, "get-personal-insights.ts"),
		"utf8",
	);

	// The whole reason this procedure exists rather than reusing the team
	// extractor: every existing insight producer writes its output to Postgres,
	// and a Temporal workflow would persist the transcript in its event history.
	it("does not start a workflow", () => {
		expect(source).not.toMatch(/startWorkflow|workflowClient|@temporalio/);
	});

	it("touches the database at all", () => {
		expect(source.match(/\b\w*[dD]b\.\w+\.\w+/g)).toBeNull();
	});

	// A generateObject failure carries the offending prompt — the transcript —
	// on its message. Interpolating it into the thrown ORPCError would push it
	// to the client and into any log that records the error.
	it("does not interpolate the model error into the message it throws", () => {
		const summariseCatch = source.slice(
			source.indexOf("Failed to summarise"),
		);
		expect(summariseCatch).not.toMatch(/\$\{\s*message\s*\}/);
	});
});

describe("router registration", () => {
	const router = readFileSync(
		resolve(process.cwd(), "../../packages/api/modules/projects/router.ts"),
		"utf8",
	);

	it("exposes listPersonalMeetings", () => {
		expect(router).toContain(
			"listPersonalMeetings: listPersonalMeetingsProcedure",
		);
	});

	it("exposes getPersonalTranscript", () => {
		expect(router).toContain(
			"getPersonalTranscript: getPersonalTranscriptProcedure",
		);
	});

	it("exposes getPersonalInsights", () => {
		expect(router).toContain(
			"getPersonalInsights: getPersonalInsightsProcedure",
		);
	});
});

/**
 * #2170 — the one procedure in this directory that is ALLOWED to write.
 *
 * Without this block the guard above quietly stops describing reality:
 * `PERSONAL_PROCEDURES` is a file-name allow-list, so a new file that persists
 * personal meeting content is invisible to it, and a future reader would take
 * "personal meetings persist nothing" at face value while a write sat next
 * door.
 *
 * The exception is narrow and the assertions pin every part of what makes it
 * safe: the write lives in its own file (so the deny-list over the READS still
 * means what it says), it needs a second feature flag, it requires the same
 * permission as adding any other project context, and — unlike the reads — it
 * is audited.
 */
const SANCTIONED_PERSISTING_PROCEDURE = "import-personal-meeting.ts";

describe(`${SANCTIONED_PERSISTING_PROCEDURE} is the single sanctioned exception`, () => {
	const source = readFileSync(
		resolve(PROCEDURE_DIR, SANCTIONED_PERSISTING_PROCEDURE),
		"utf8",
	);

	// If someone "simplifies" by folding the import into a read procedure, the
	// deny-list above starts failing — this assertion states the intent that
	// makes that failure legible rather than a puzzle.
	it("is not one of the never-persist procedures", () => {
		expect(PERSONAL_PROCEDURES).not.toContain(
			SANCTIONED_PERSISTING_PROCEDURE,
		);
	});

	it("needs its own feature flag on top of PERSONAL_MEETINGS", () => {
		expect(source).toContain('isFeatureEnabled("MEETING_CONTEXT_IMPORT")');
		expect(source).toContain('isFeatureEnabled("PERSONAL_MEETINGS")');
	});

	// CONTEXT_CREATE, not PROJECT_READ: storing a meeting is adding project
	// context, and the card requires the project's context permission to govern
	// who may do it. requireInputOrgPermission is not optional — hasProjectAccess
	// ignores its organizationId argument.
	it("requires the project's context-create permission, on both middlewares", () => {
		expect(source).toContain(
			"requireInputOrgPermission(Permissions.CONTEXT_CREATE)",
		);
		expect(source).toContain(
			"requireProjectPermission(Permissions.CONTEXT_CREATE)",
		);
	});

	it("takes the caller's id from the session, never from input", () => {
		expect(source).not.toMatch(/input\.userId/);
	});

	/**
	 * The two audit middlewares are treated differently, and the split is the
	 * point.
	 *
	 * SUCCESS is audited. The activity middleware records every successful
	 * import, and its row carries no input snapshot — so it says "this person
	 * imported a meeting into this project" without reproducing the meeting.
	 * That is the record an org admin is entitled to for the one publishing
	 * action in this lane, and suppressing it would make that action invisible.
	 *
	 * FAILURE is suppressed. The error middleware snapshots the validated
	 * input; `joinUrl` is not on the sensitive-key denylist, and a Teams join
	 * URL is a meeting CAPABILITY url — #1899 kept it off the error path
	 * deliberately (DEF-6). A throw means the import did not happen, so such a
	 * row would publish the address of a still-private meeting into the
	 * project's org tenant in exchange for nothing.
	 */
	it("is audited on success — absent from the activity middleware's skip list", () => {
		const activitySource = readFileSync(
			resolve(
				process.cwd(),
				"../../packages/api/orpc/middleware/audit-activity-middleware.ts",
			),
			"utf8",
		);
		expect(activitySource).not.toContain(
			"projects.meetingDigest.importPersonalMeeting",
		);
	});

	it("snapshots nothing on failure — hardcoded into the error middleware's ALWAYS_SKIP_PATHS", () => {
		const errorSource = readFileSync(
			resolve(
				process.cwd(),
				"../../packages/api/orpc/middleware/audit-error-middleware.ts",
			),
			"utf8",
		);
		expect(errorSource).toMatch(
			/ALWAYS_SKIP_PATHS\s*=\s*\[[^\]]*"projects\.meetingDigest\.importPersonalMeeting"/s,
		);
	});

	it("is registered on the router, so the audit path can name it", () => {
		const router = readFileSync(
			resolve(
				process.cwd(),
				"../../packages/api/modules/projects/router.ts",
			),
			"utf8",
		);
		expect(router).toContain(
			"importPersonalMeeting: importPersonalMeetingProcedure",
		);
	});
});

describe("the #2104 client cache never reaches server code", () => {
	// The insights cache is browser-local by design. If a procedure ever
	// imports it, personal insight data has crossed to the server — and the
	// user-facing promise that "nothing is saved to our database" silently
	// becomes false. That promise is the entire reason #2104 went client-side
	// instead of using the encrypted server storage the ticket also offered.
	it.each(PERSONAL_PROCEDURES)(
		"%s does not import the client insights cache",
		(filename) => {
			const source = readFileSync(
				resolve(PROCEDURE_DIR, filename),
				"utf8",
			);
			expect(source).not.toContain("personal-insights-cache");
		},
	);
});

describe("the #2104 client cache stores no transcript text", () => {
	const CACHE = resolve(
		process.cwd(),
		"modules/saas/meeting-digest/lib/personal-insights-cache.ts",
	);
	const SHEET = resolve(
		process.cwd(),
		"modules/saas/meeting-digest/components/PersonalMeetingSheet.tsx",
	);

	// NOTE: deliberately NOT `expect(source).not.toMatch(/transcript/i)`.
	// That was the first draft of this guard and it is wrong — it forbids the
	// module from *documenting* the constraint it is under, punishing the
	// comment that tells the next reader why this file exists. Guard the wiring
	// instead of the prose.
	it("the cache module cannot reach the transcript procedure", () => {
		const source = readFileSync(CACHE, "utf8");
		expect(source).not.toContain("getPersonalTranscript");
		expect(source).not.toContain("orpcClient");
	});

	// A type signature enforces shape, not provenance: nothing in the type
	// system stops a caller passing transcript text as `summary`. So assert on
	// the call site, in the same source-level spirit as the guards above.
	it("the sheet never passes transcript content into the cache writer", () => {
		const source = readFileSync(SHEET, "utf8");
		const writes = source.match(/writeInsights\([\s\S]*?\n\t*\);/g) ?? [];
		expect(writes.length).toBeGreaterThan(0);
		for (const call of writes) {
			expect(call).not.toMatch(/\bcontent\b/);
			expect(call).not.toMatch(/transcript/i);
		}
	});
});

describe("every sign-out path purges cached personal summaries (#2104)", () => {
	// Found in live QA on the PR preview: purgeUser was wired into UserMenu
	// only, but the sidebar Logout in NavBar is a SEPARATE, duplicated
	// signOut handler — and it is the one users actually click. Signing out
	// left every cached summary on disk.
	//
	// Source-level, and deliberately enumerating the files rather than
	// grepping the whole tree: a new duplicate sign-out handler should be a
	// conscious decision to add here, not something that silently inherits a
	// pass.
	const SIGN_OUT_COMPONENTS = [
		"modules/saas/shared/components/NavBar.tsx",
		"modules/saas/shared/components/UserMenu.tsx",
	] as const;

	it.each(SIGN_OUT_COMPONENTS)("%s purges on sign-out", (relPath) => {
		const source = readFileSync(resolve(process.cwd(), relPath), "utf8");

		// It calls signOut...
		expect(source).toMatch(/authClient\.signOut\(/);
		// ...and actually CALLS purgeUser with the session user's id when it
		// does. Asserting on the bare name `purgeUser` is not enough: the
		// import statement alone satisfies it, so deleting the call still
		// passed. Verified by deleting the call and watching this fail.
		expect(source).toMatch(/purgeUser\(\s*user\??\.id\s*\)/);
	});
});

describe("turning personal meetings off revokes cache consent (#2104)", () => {
	// The tab used to call purgeProject directly, which erased the DATA but
	// left the consent key in localStorage — so re-enabling personal meetings
	// silently resumed caching without a fresh opt-in click. disableCache()
	// removes the key AND purges, so routing through it is the whole fix.
	//
	// Asserting on the bare name `disableCache` is not enough: it is already
	// destructured at the top of the component, so the destructuring line
	// alone would satisfy it. Match the CALL. (DEF-1, PR #2559.)
	it("MeetingDigestTab disables the cache when personal meetings are disabled", () => {
		const source = readFileSync(
			resolve(
				process.cwd(),
				"modules/saas/meeting-digest/components/MeetingDigestTab.tsx",
			),
			"utf8",
		);

		expect(source).toMatch(/const handleDisablePersonal = useCallback\(/);
		// Anchored to a line whose first non-whitespace content IS the call,
		// not merely a substring match — `disableCache\(\s*\)` alone is
		// satisfied by the explanatory comment a few lines above the real
		// call ("// disableCache() clears the consent key AND purges the
		// project's..."), so deleting the actual statement left this guard
		// green. Verified by deleting the call and watching this fail.
		expect(source).toMatch(/^\s*disableCache\(\);/m);
	});

	// The half-copy must be gone, not merely bypassed. Leaving the import in
	// place invites the next editor to reach for it again and re-open the
	// exact drift this task closes.
	it("MeetingDigestTab no longer reaches past the consent hook to purge", () => {
		const source = readFileSync(
			resolve(
				process.cwd(),
				"modules/saas/meeting-digest/components/MeetingDigestTab.tsx",
			),
			"utf8",
		);

		expect(source).not.toMatch(/purgeProject/);
	});
});
