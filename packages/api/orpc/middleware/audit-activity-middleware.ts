/**
 * Automatic audit-activity middleware.
 *
 * Sibling of `audit-error-middleware.ts`. That one captures every FAILED
 * procedure call; this one captures every SUCCESSFUL state-changing call.
 *
 * ## Why this exists
 *
 * `AUDIT_ACTIONS` is a closed, curated taxonomy of security-relevant events,
 * and its closedness is load-bearing — it makes a typo in a hand-written action
 * key observable. But a curated list only ever covers what somebody remembered
 * to add, so the long tail of ordinary mutations (documents, workflows, agents,
 * test cases, prompts, reports) left no trace in the ledger at all.
 *
 * Closing that gap by hand would mean hundreds of taxonomy entries and hundreds
 * of call sites, and it would drift again with the next new procedure. So the
 * problem is inverted: capture is the default, derived from the procedure path,
 * under the open `activity.*` namespace. Curated events keep their guarantees;
 * the long tail stops being invisible.
 *
 * ## What is captured
 *
 * Successful calls that change state. A WORM, cryptographically
 * sealed, retained ledger is the wrong place for "someone loaded a list", and
 * burying the trail in read noise is what makes an audit log unusable. Sensitive
 * reads that DO warrant a record already have curated actions (`audit.viewed`,
 * `userActivity.viewed`).
 *
 * Procedures that declare no method at all are treated as non-GET: oRPC's
 * default is POST, so undeclared means "probably a mutation".
 *
 * **But the method alone is a poor proxy for "this mutates", so it is not the
 * rule.** A repository scan counted **75** read procedures declaring `POST`
 * because they take a request body — a stats window, a typeahead term — rather
 * than because they change anything. Staging testing found the sharpest case:
 * the audit-log page's own reads were captured, so the ledger accumulated rows
 * about people reading the ledger.
 *
 * So {@link shouldCapture} additionally drops a non-GET call whose procedure is
 * named like a read. A name would normally be a weak signal — but here it is
 * **verified rather than trusted**: `audit-activity-read-name-ratchet.test.ts`
 * scans every procedure in the repository and fails if any name matching the
 * read pattern contains a write call. Zero do today, so the classification is a
 * checked fact rather than a guess, and it stays one.
 * `.meta({ auditActivity: "always" | "never" })` overrides it per procedure.
 *
 * The asymmetry is deliberate throughout: a missing record cannot be recovered
 * later, an excess one can be filtered, so every uncertain case captures.
 *
 * ## Deduplication
 *
 * A procedure that already emitted a curated row sets a flag on the timing
 * middleware's AsyncLocalStorage frame, and this middleware then stays silent.
 * Without that, every meaningful action would appear twice.
 *
 * ## Safety invariants
 *
 *  1. Never alters the handler's return value — the original output is
 *     returned untouched.
 *  2. Never throws from the capture path. A bug here must not fail a mutation
 *     that already succeeded and committed.
 *  3. Uses fire-and-forget `recordAuditFromRequest`, so the audit write never
 *     delays the response.
 *  4. Honours two operator kill switches, mirroring the error middleware:
 *     - `FABRIC_AUDIT_ACTIVITY_CAPTURE_DISABLED=true` — skip all capture.
 *     - `FABRIC_AUDIT_ACTIVITY_CAPTURE_SKIP_PATHS=a.b,c.*` — skip listed
 *       paths (trailing `*` is a prefix match).
 *
 * ## Volume
 *
 * This multiplies audit-row volume by roughly the ratio of mutations to
 * previously-curated events, which is large. `FABRIC_AUDIT_LOG_RETENTION_DAYS`
 * is the pressure valve, and the row is deliberately lean — no input snapshot,
 * unlike the error middleware's payload.
 */

import { os } from "@orpc/server";
import { ACTIVITY_ACTION_PREFIX, ACTIVITY_CATEGORY } from "@repo/database";
import {
	type AuditRequestContext,
	recordAuditFromRequest,
} from "../../lib/audit";
import {
	readOrganizationIdFromInput,
	readProjectIdFromInput,
} from "./audit-error-middleware";
import { hasCuratedAuditWritten } from "./audit-timing-middleware";

const DISABLED_ENV = "FABRIC_AUDIT_ACTIVITY_CAPTURE_DISABLED";
const SKIP_PATHS_ENV = "FABRIC_AUDIT_ACTIVITY_CAPTURE_SKIP_PATHS";

/**
 * Paths never captured, because the RECORD ITSELF would be the privacy problem.
 *
 * The personal-calendar procedures carry data whose mere access is the risk, and
 * the audit row would land in the project's ORG tenant where org admins could
 * read it. Hardcoded rather than left to the skip-path env so a configuration
 * edit cannot re-enable it — the same reasoning, and the same list, as the error
 * middleware's unconditional suppressions.
 *
 * Kept SEPARATE from the list below on purpose. These two lists have different
 * invariants: this one is a privacy control that must never be relaxed, the other
 * is a workaround that should shrink and eventually disappear. Merged, a future
 * edit reasoning "these are just the POST-workaround entries, drop them now the
 * proper fix landed" could delete a privacy control by accident.
 */
const PRIVACY_SKIP_PATHS = [
	"projects.meetingDigest.listPersonalMeetings",
	"projects.meetingDigest.getPersonalTranscript",
	"projects.meetingDigest.getPersonalInsights",
	"projects.meetingDigest.saveAgenda",
] as const;

/**
 * The one read on the audit surface the name rule cannot recognise.
 *
 * `audit.stats`, `audit.apiKeys.list`, `audit.searchMembers` and
 * `audit.searchProjects` used to be listed here too. They are gone because
 * {@link hasReadShapedName} now recognises all four by name — which is the
 * point of that rule: this list was a per-path workaround for a general
 * problem, and the general problem is fixed.
 *
 * `tracedRequest` is named like neither a read nor a write, so it still needs
 * saying explicitly. It declares POST because it takes a correlation ID in the
 * body. Without it, opening a traced request writes an activity row about
 * someone looking at the ledger — the self-referential loop found in staging.
 */
const SELF_REFERENCE_SKIP_PATHS = ["audit.tracedRequest"] as const;

const ALWAYS_SKIP_PATHS: readonly string[] = [
	...PRIVACY_SKIP_PATHS,
	...SELF_REFERENCE_SKIP_PATHS,
];

function isCaptureDisabled(): boolean {
	return process.env[DISABLED_ENV] === "true";
}

function readSkipPatterns(): { exact: Set<string>; prefixes: string[] } {
	const raw = process.env[SKIP_PATHS_ENV];
	if (!raw || raw.trim().length === 0) {
		return { exact: new Set(), prefixes: [] };
	}
	const exact = new Set<string>();
	const prefixes: string[] = [];
	for (const part of raw.split(",")) {
		const trimmed = part.trim();
		if (trimmed.length === 0) continue;
		if (trimmed.endsWith("*")) {
			prefixes.push(trimmed.slice(0, -1));
		} else {
			exact.add(trimmed);
		}
	}
	return { exact, prefixes };
}

export function shouldSkipPath(path: string): boolean {
	if (ALWAYS_SKIP_PATHS.includes(path)) return true;
	const { exact, prefixes } = readSkipPatterns();
	if (exact.has(path)) return true;
	return prefixes.some((prefix) => path.startsWith(prefix));
}

function renderProcedurePath(path: readonly string[]): string {
	return path.length === 0 ? "(root)" : path.join(".");
}

/**
 * Read the declared HTTP method off the procedure's contract definition.
 *
 * Shape verified against `@orpc/server`'s own type declarations:
 * `Procedure['~orpc']` is a `ProcedureDef` extending `ContractProcedureDef`,
 * which carries `route: Route`, whose `method` is optional.
 *
 * Returns `undefined` when no method is declared.
 */
export function readDeclaredMethod(procedure: unknown): string | undefined {
	const def = (procedure as { "~orpc"?: { route?: { method?: unknown } } })?.[
		"~orpc"
	];
	const method = def?.route?.method;
	return typeof method === "string" ? method : undefined;
}

/**
 * Is this call state-changing for capture purposes?
 *
 * Exported so the decision is unit-testable in isolation — it is the single
 * rule that determines audit volume, and getting it wrong is expensive in both
 * directions.
 */
export function isCapturableMethod(method: string | undefined): boolean {
	if (method === undefined) {
		// oRPC defaults to POST; undeclared means "probably a mutation".
		return true;
	}
	return method.toUpperCase() !== "GET";
}

/**
 * Names that read rather than write.
 *
 * Two groups, and the split is load-bearing. The long prefixes are unambiguous
 * anywhere in a name. The short ones must be followed by a capital or end of
 * name, because as bare prefixes they match real mutations: `can` matches
 * **cancel**, `is` matches **issue**, `has` matches **hash**. An untightened
 * version of this pattern classified four `cancel*` procedures as reads.
 *
 * `resolve` is deliberately absent — `resolveContentDrift` writes.
 */
const READ_NAME_PATTERN =
	/^(?:(?:list|search|stats|export|preview|validate|fetch|summar|compare|estimate|available)|(?:get|count|check|find|query|read|has|is|can|diff|detect)(?=[A-Z]|$))/;

export function hasReadShapedName(path: readonly string[]): boolean {
	const leaf = path[path.length - 1];
	return typeof leaf === "string" && READ_NAME_PATTERN.test(leaf);
}

/**
 * The capture decision.
 *
 * The HTTP verb alone was the original rule and it over-captures badly: a
 * repository scan counted **75** read procedures declaring POST because they
 * take a request body — a stats window, a typeahead term — not because they
 * change anything. The sharpest case found in staging was the audit-log page's
 * own reads being captured, so the ledger accumulated rows about people reading
 * the ledger.
 *
 * So a non-GET call is dropped when the procedure is named like a read. That is
 * safe here specifically because it is enforced from the other side too:
 * `audit-activity-read-name-ratchet.test.ts` scans every procedure in the
 * repository and fails if any name matching this pattern contains a write call.
 * The pattern is not trusted — it is checked. Today zero procedures violate it.
 *
 * `.meta({ auditActivity: "always" | "never" })` overrides the inference for a
 * procedure where a human knows better; the ratchet accepts `"always"` as the
 * remedy for a read-named writer, so a genuine one does not have to be renamed.
 *
 * The asymmetry is deliberate: a missing record cannot be recovered later, an
 * excess one can be filtered. So anything not clearly a read is captured.
 */
export function shouldCapture(args: {
	method: string | undefined;
	readShapedName: boolean;
	metaOverride?: ActivityCaptureMeta;
}): boolean {
	// An explicit declaration on the procedure always wins — it is a human
	// saying what the code does, which beats any inference.
	if (args.metaOverride === "always") return true;
	if (args.metaOverride === "never") return false;
	if (!isCapturableMethod(args.method)) return false;
	return !args.readShapedName;
}

/**
 * Optional per-procedure declaration, for the cases where neither signal is
 * right: `.meta({ auditActivity: "never" })` on a read whose name does not look
 * like one, or `"always"` on a side-effecting call that both writes nothing to
 * Postgres and happens to be named like a read.
 */
export type ActivityCaptureMeta = "always" | "never";

export function readActivityCaptureMeta(
	procedure: unknown,
): ActivityCaptureMeta | undefined {
	const meta = (
		procedure as {
			"~orpc"?: { meta?: { auditActivity?: unknown } };
		}
	)?.["~orpc"]?.meta?.auditActivity;
	return meta === "always" || meta === "never" ? meta : undefined;
}

/**
 * Derive the audit action key from the procedure path.
 * `["projects", "create"]` -> `"activity.projects.create"`.
 */
export function deriveActivityAction(path: readonly string[]): string {
	return `${ACTIVITY_ACTION_PREFIX}${renderProcedurePath(path)}`;
}

/**
 * Best-effort resource identification from the handler's own output.
 *
 * A mutation usually returns the thing it touched, so an `id` on the result is
 * the cheapest honest way to make a row point at something. Only a top-level
 * `id` string is read: guessing deeper would risk pulling user content into the
 * ledger, and the row deliberately carries no input snapshot.
 */
function readResourceIdFromOutput(output: unknown): string | undefined {
	if (output && typeof output === "object" && "id" in output) {
		const candidate = (output as { id?: unknown }).id;
		if (typeof candidate === "string" && candidate.length > 0) {
			return candidate;
		}
	}
	return undefined;
}

export const auditActivityMiddleware = os
	.$context<{ headers: Headers }>()
	.middleware(async ({ context, next, path, procedure }, input) => {
		const result = await next({});

		try {
			if (isCaptureDisabled()) return result;

			const rendered = renderProcedurePath(path);
			if (shouldSkipPath(rendered)) return result;
			if (
				!shouldCapture({
					method: readDeclaredMethod(procedure),
					readShapedName: hasReadShapedName(path),
					metaOverride: readActivityCaptureMeta(procedure),
				})
			)
				return result;
			// A curated row for this call already exists — stay silent.
			if (hasCuratedAuditWritten()) return result;

			// Unauthenticated calls (sign-in attempts, public endpoints) have no
			// actor to attribute. Auth events that matter already have curated
			// actions, so there is nothing to add here.
			const auditContext = context as unknown as AuditRequestContext;
			if (!auditContext?.user?.id) return result;

			const resourceId = readResourceIdFromOutput(
				(result as { output?: unknown })?.output,
			);

			// Tenant resolution, using the SAME rule as the error middleware:
			// an explicit `organizationId` on the input wins (including an
			// explicit null, which means personal context), otherwise the
			// session's active organization, otherwise null.
			//
			// This is load-bearing, and omitting it was the whole point of this
			// feature quietly failing. The org audit viewer filters strictly on
			// `organizationId = <org>`, so a row written with null lands in the
			// acting user's PERSONAL bucket and is invisible to org admins and
			// auditors — meaning every automatically-captured mutation performed
			// inside an organization was missing from that organization's trail,
			// which is exactly the completeness gap this middleware exists to
			// close. The error middleware learned the same lesson first; its
			// comment records that orphaned rows were "invisible to any viewer".
			//
			// Unlike that middleware this one mounts INSIDE the auth chain, so
			// `context.session` is already populated and no header re-resolution
			// is needed.
			const inputOrg = readOrganizationIdFromInput(input);
			const organizationId =
				inputOrg !== undefined
					? inputOrg
					: (auditContext.session?.activeOrganizationId ?? null);
			const projectId = readProjectIdFromInput(input);

			recordAuditFromRequest(auditContext, {
				action: deriveActivityAction(path),
				category: ACTIVITY_CATEGORY,
				outcome: "success",
				severity: "info",
				organizationId,
				...(projectId ? { projectId } : {}),
				...(resourceId
					? { resource: { type: "procedure_result", id: resourceId } }
					: {}),
				metadata: { procedure: rendered },
			});
		} catch (error) {
			// The mutation already succeeded and committed. Losing its activity
			// row is strictly better than turning a successful write into an
			// error response.
			console.error("[auditActivityMiddleware] capture failed", {
				path: renderProcedurePath(path),
				error: error instanceof Error ? error.message : String(error),
			});
		}

		return result;
	});
