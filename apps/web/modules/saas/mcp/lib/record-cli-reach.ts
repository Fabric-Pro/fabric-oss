/**
 * Record that a CLI reached an organization over MCP (Fizzy #2457, R2/R25/R32).
 *
 * Both protocol entry points answer the same question — has a coding CLI ever
 * reached this organization — and neither may answer it by inference. Scopes
 * are enforced per tool call, so a key can authenticate and be refused by every
 * tool; usage counters are stamped on both hosts immediately after the secret
 * matches, BEFORE the owner lookup and BEFORE the membership check, so they
 * count requests that then return 401; and a personal key's organization is
 * only *defaulted* from its holder's memberships, so a client naming a
 * different one on the organization header would be read as disconnected. Every
 * one of those re-derivations was wrong in a reachable state, which is why the
 * runtime writes the fact for itself instead — and why it writes it from here
 * rather than from a copy on each server. `record-organization-refusal.ts`
 * beside this file exists for the same reason.
 *
 * Fire-and-forget on purpose, matching the usage-counter write it sits beside:
 * a failure to record must never fail the request being recorded. Not FLOATING,
 * though: the continuation is handed to `runInBackground`, which registers it
 * with the runtime via `waitUntil` so it outlives the response. Both routes
 * declare the Node runtime on a serverless platform, where a bare
 * `void promise` is dropped the moment the invocation is frozen after the
 * response returns.
 *
 * That distinction matters more here than for `record-organization-refusal.ts`
 * beside it, which floats its audit write: a dropped audit row is a lost log
 * line, whereas a dropped reach record is a feature that silently never works.
 * This row is the one fact the connection nudge and the readiness row read, and
 * nothing recomputes it, so an organization whose only write was dropped reads
 * as disconnected forever — the nudge never stops showing and the readiness row
 * never completes.
 *
 * `runInBackground` registers the rejection handler and logs the failure
 * itself, which is why nothing here adds a `.catch` of its own. The dynamic
 * `import("@repo/database")` stays: both routes already resolve that module per
 * request the same way, and keeping it off this module's load path keeps the
 * Prisma client out of the routes' module initialization.
 *
 * **The rollout gate is deliberately NOT consulted here.** `CLI_CONNECTION_NUDGE`
 * decides who SEES the fact, not whether it is recorded, and recording has to
 * run ahead of the rollout: the answer is built from records that only exist
 * once a CLI has actually reached Fabric, so gating the write would mean
 * switching an organization on and showing it an empty answer for a team that
 * has been connected all along. Seeding from the usage counters instead is the
 * one thing this whole design exists to refuse — see the module doc above.
 *
 * The consequence is a deployment contract, and it belongs written down rather
 * than discovered: the migration must land BEFORE this code. The readiness read
 * path is isolated from the new tables while the gate is off, but this path is
 * not, so code running ahead of its schema turns every authenticated MCP
 * request into a swallowed write failure and a log line — the request still
 * succeeds, and the reach evidence for that window is simply lost.
 */

import { runInBackground } from "@repo/api/modules/weave/lib/run-in-background";

/**
 * Which key row proved this request, if a key proved it at all.
 *
 * A discriminated union rather than a pair of loose fields, and OPTIONAL on the
 * authentication outcome rather than nullable: a browser session and an
 * anonymous fall-through reach the same endpoints, and neither is a CLI, so
 * those branches simply do not set it and `recordCliReach` returns without
 * writing.
 *
 * That omission is a CONVENTION, not something the compiler enforces — say so
 * plainly, because believing otherwise is what would let it rot. Both hosts
 * hang `keyIdentity` off a flat `AuthResult` whose `credential` is a plain
 * string union, so `{ credential: "session", keyIdentity: toUserKeyIdentity(id) }`
 * type-checks today. What actually holds the line is the pair of connection-
 * record suites, which assert that a session-authenticated request schedules
 * nothing. Making `AuthResult` a real discriminated union, so the session
 * variant cannot carry an identity at all, is the fix and is deliberately
 * deferred — it threads through both route files.
 *
 * Guarding on scopes instead cannot work — a session carries `["*"]`, wider
 * than any key.
 *
 * `credentialKind` mirrors `CliCredentialKind` in the schema, because
 * `credentialId` is polymorphic across `user_api_key` and
 * `organization_api_key` and the id alone does not identify a row.
 */
export type McpKeyIdentity =
	| { credentialKind: "USER_API_KEY"; credentialId: string }
	| { credentialKind: "ORGANIZATION_API_KEY"; credentialId: string };

/**
 * The funnel event R25 asks for: an organization reached MCP for the first
 * time. What is exactly-once is the WINNER: `recordOrganizationCliReach`'s
 * `createMany({ skipDuplicates: true })` resolves the race atomically at the
 * unique index, so no organization can ever produce two of these — the row
 * makes duplicates impossible.
 *
 * Delivery of this log line is a separate question, and the honest answer is
 * at-most-once, not exactly-once. It is emitted by the same process that just
 * won the row, AFTER that insert has already committed, and both routes run
 * on a serverless platform where the invocation can be frozen the instant the
 * response is sent. A winner that dies between the commit and this
 * `console.info` — crash, timeout, a `waitUntil` that runs out before the
 * continuation resumes — never gets a retry, because the row it would retry
 * against already exists. So a first reach can go un-logged; it can never be
 * logged twice.
 *
 * There is no server-side analytics transport in this repository — the PostHog
 * provider is `posthog-js`, a browser module gated on cookie consent, and the
 * other three events in R25 are emitted from the client surfaces that render.
 * So this is a structured log line for live observation, not the record — a
 * best-effort convenience layered on top of a fact that does not need it. The
 * durable signal for the funnel step, the thing to query when counting
 * adoption, is the `OrganizationCliFirstReach` row itself, written before this
 * line runs and, by design, never invalidated. If this log line ever had to
 * become the authoritative source — feeding a required downstream system
 * rather than a dashboard — closing the gap would need a transactional outbox
 * or a delivery-state column on the row, so a dead winner leaves something for
 * a later request to notice and retry. That is deliberately not built here: it
 * is real engineering for a `console.info`, and the row already answers the
 * question a human or a dashboard actually asks.
 */
export const CLI_FIRST_REACH_EVENT = "cli.organization.firstReach" as const;

/**
 * What a caller has to be able to say about the request. Both hosts' `AuthResult`
 * satisfies it structurally, so no call site converts anything.
 */
interface CliReachSource {
	organizationId: string | null;
	keyIdentity?: McpKeyIdentity;
}

/**
 * Which key row matched, carried alongside the identity so the connection
 * record names THIS key rather than the kind of key (Fizzy #2457, R2).
 * `undefined` only if the verifier reported a valid key without an id, which
 * it never does — and an absent identity writes nothing rather than
 * guessing.
 *
 * Both hosts build a personal key's identity from the same verifier result,
 * which is why this lives here instead of being reconstructed on each side.
 */
export function toUserKeyIdentity(
	keyId: string | undefined,
): McpKeyIdentity | undefined {
	return keyId
		? { credentialKind: "USER_API_KEY", credentialId: keyId }
		: undefined;
}

/**
 * Which key row matched, for an organization key. Always present: unlike the
 * personal-key verifier, the lookup that reaches this branch already found
 * the row by id, so there is no absent case to guard against here.
 */
export function toOrganizationKeyIdentity(
	credentialId: string,
): McpKeyIdentity {
	return { credentialKind: "ORGANIZATION_API_KEY", credentialId };
}

/**
 * Write the connection record for one authenticated request.
 *
 * Call ONLY once the runtime has already decided the request is legitimate: the
 * credential matched, its owner was loaded, and membership was re-read. Never
 * from the point the secret matched — see the module doc.
 *
 * A `null` source is the hosted server's anonymous public session, and an
 * absent `keyIdentity` is a browser session. Both return here without writing.
 */
export function recordCliReach(source: CliReachSource | null): void {
	const organizationId = source?.organizationId;
	const keyIdentity = source?.keyIdentity;
	if (!organizationId || !keyIdentity) {
		return;
	}

	const { credentialKind, credentialId } = keyIdentity;

	runInBackground(
		import("@repo/database").then(
			async ({ recordOrganizationCliReach }) => {
				const { firstReachForOrganization } =
					await recordOrganizationCliReach({
						organizationId,
						credentialKind,
						credentialId,
					});

				if (firstReachForOrganization) {
					console.info(`[Fabric MCP] ${CLI_FIRST_REACH_EVENT}`, {
						organizationId,
						credentialKind,
					});
				}
			},
		),
	);
}
