/**
 * Every `publicProcedure` must be a deliberate one, and none may pretend to be
 * guarded.
 *
 * `prompts.browse.system` was public by accident and stayed that way. It carried
 * a `requirePermission(...)` call that reads as a gate but returns `next()`
 * unconditionally when there is no tenant context — which a public procedure
 * never has. It served every system prompt, with content, to anyone on the
 * internet, and nothing in the pipeline noticed.
 *
 * This is the thing that would have noticed. It is a source-level sweep because
 * being public is decided by which builder a file uses, and a handler test
 * cannot see that: the handler body is identical either way.
 *
 * Two lists, deliberately separate:
 *
 *   ALLOWED         reviewed, with the reason written down.
 *   PENDING_REVIEW  public before this test existed. Frozen, not endorsed.
 *
 * The pending list may only shrink. That is the whole mechanism: existing
 * exposure is recorded rather than silently inherited, and nothing NEW can join
 * either list without someone typing a reason.
 *
 * Run with:
 *   pnpm --filter @repo/api test orpc/__tests__/public-procedure-allowlist.test.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MODULES = join(__dirname, "..", "..", "modules");

/** Reviewed and genuinely public, each with why. */
const ALLOWED: Record<string, string> = {
	"agent-deployments/procedures/webhook-handler.ts":
		"Receives callbacks from deployed agents; authenticated by its own signature check, not a session.",
	"ai-config/procedures/resolution/resolve-for-agent.ts":
		"Called by agent runtimes holding an AI token rather than a user session.",
	"auth/procedures/resend-verification-email.ts":
		"The caller has not verified their email yet, so by definition has no usable session.",
	"auth/procedures/revoke-email-change.ts":
		"Reached from a link in an email by someone who may not be signed in — that is the point of the revoke path.",
	"integrations/procedures/github-oauth.ts":
		"OAuth callback: the provider redirects here without the app's session cookie.",
	"integrations/procedures/gitlab-oauth.ts": "OAuth callback, as GitHub.",
	"integrations/procedures/oauth.ts": "OAuth callback, as above.",
	"integrations/procedures/teams-events.ts":
		"Receives Teams event callbacks from Microsoft, authenticated by the request's own signature.",
	"kanban/procedures/webhook.ts":
		"Webhook receiver for the local kanban CLI.",
	"mcp/procedures/oauth.ts": "OAuth callback for MCP server connections.",
	"mcp/procedures/atlassian-cloud.ts": "Atlassian OAuth/discovery callback.",
	"projects/procedures/code-indexing/github-webhook.ts":
		"GitHub push webhook, verified by its signature header.",
	"runtime/procedures/resolve-tenant.ts":
		"Self-authenticating: takes an apiKey in the payload and calls validateApiKey. Agent runtimes have no session cookie.",
	"runtime/procedures/get-agent.ts":
		"Self-authenticating on an apiKey in the payload, as resolve-tenant.",
	"runtime/procedures/resolve-model.ts":
		"Self-authenticating on an apiKey in the payload, as resolve-tenant.",
	"waitlist/procedures/signup.ts":
		"Pre-launch waitlist signup — the caller has no account yet, which is the point.",
};

/**
 * Public before this test existed. NOT reviewed and NOT endorsed — recorded so
 * the exposure is visible and cannot grow.
 *
 * Every entry below pairs `publicProcedure` with a `requirePermission(...)`
 * call that does nothing, which is the exact shape of the bug this test was
 * written for. They need someone to decide, per endpoint, whether the data is
 * meant to be public. Raised separately; do not add to this list.
 */
const PENDING_REVIEW: Record<string, string> = {
	"kanban/procedures/create-token.ts":
		"POST /kanban/token/exchange. Appears to verify its own signed token (KANBAN_TOKEN_ISSUER), but the requirePermission(STORY_CREATE) beside it is inert.",
	"kanban/procedures/status.ts":
		"GET /kanban/status. Its comment states it is public so the frontend can poll CLI connection status; requirePermission(STORY_UPDATE) is inert.",
	"mcp/procedures/public-registry.ts":
		"Named as a public registry, so likely deliberate — unconfirmed.",
	"organizations/procedures/generate-organization-slug.ts":
		"GET /organizations/generate-slug. If it checks slug availability it may reveal which organizations exist; requirePermission(ORG_UPDATE) is inert.",
	"rag-providers/procedures/list-available-providers.ts":
		"Its comment states 'no authentication required'; requirePermission(ORG_RAG_SETTINGS_READ) is inert. Likely a static provider catalog.",
	"search-providers/procedures/list-available-providers.ts":
		"Same shape as the RAG provider list above, and the same inert permission call.",
};

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "__tests__") {
			continue;
		}
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			walk(full, out);
		} else if (entry.endsWith(".ts")) {
			out.push(full);
		}
	}
	return out;
}

const rel = (file: string) =>
	file
		.slice(MODULES.length + 1)
		.split("\\")
		.join("/");

/** Files that BUILD a procedure from publicProcedure, not merely import it. */
function publicProcedureFiles(): string[] {
	const hits: string[] = [];
	for (const file of walk(MODULES)) {
		if (/(?::|=)\s*publicProcedure\b/.test(readFileSync(file, "utf8"))) {
			hits.push(rel(file));
		}
	}
	return hits.sort();
}

describe("public procedures", () => {
	const found = publicProcedureFiles();

	it("found some to check", () => {
		// Guards the guard. A broken sweep makes everything below vacuous,
		// which is precisely how this class of bug survives.
		expect(found.length).toBeGreaterThan(5);
	});

	it("has a written reason for every one", () => {
		const undocumented = found.filter(
			(f) => !(f in ALLOWED) && !(f in PENDING_REVIEW),
		);

		expect(
			undocumented,
			`Builds a publicProcedure with no recorded reason. Public means reachable with NO session, and requirePermission() does not gate one — it returns next() when there is no tenant context. Either protect it, or add it to ALLOWED with the reason:\n  ${undocumented.join("\n  ")}`,
		).toEqual([]);
	});

	it("keeps no stale entries", () => {
		// An entry left behind after a procedure was protected would quietly
		// permit it to go public again.
		const listed = [
			...Object.keys(ALLOWED),
			...Object.keys(PENDING_REVIEW),
		];
		const stale = listed.filter((f) => !found.includes(f));
		expect(
			stale,
			`Listed as public but no longer building a publicProcedure — remove:\n  ${stale.join("\n  ")}`,
		).toEqual([]);
	});

	it("does not let the pending-review list grow", () => {
		// A ratchet: this number may fall as endpoints are reviewed, never rise.
		// Lower it as each one is decided; a rise means unreviewed exposure was
		// added, which is the thing this file exists to prevent.
		expect(Object.keys(PENDING_REVIEW).length).toBeLessThanOrEqual(6);
	});

	it("keeps the prompt browse endpoint protected", () => {
		// The one this test was written for. It serves prompt content.
		expect(found).not.toContain("prompts/procedures/browse.ts");
	});
});
