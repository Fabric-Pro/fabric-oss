/**
 * The deterministic run id behind `dispatchAgenticRun`'s idempotency key
 * (Fizzy #2233 follow-up: "Why it compounds").
 *
 * A run's id used to be a fresh `cuid()` on every dispatch, so a same-tick
 * double click — the client's `disabled` guard has not re-rendered yet — or
 * an ordinary network retry created a second run, and a second bill, for a
 * single Start press. The client now sends a key that stays STABLE across
 * retries of the same attempt (see `RunConfigurationDialog`'s
 * `idempotencyKey` state) and changes the moment anything about the attempt
 * itself changes. Turning that key into the run's own id — rather than
 * checking it separately — is what makes the row's primary key the guard: a
 * retried dispatch collides on `P2002` instead of racing a second insert.
 */

import { createHash } from "node:crypto";

/**
 * Derive the run id a given (project, user, idempotency key) triple always
 * produces.
 *
 * `projectId` and `userId` are hashed INTO the id, not merely checked
 * against it afterward, so the id itself is the tenant boundary: replaying
 * or guessing someone else's key can never address their run, because
 * anyone else's key hashes to a different id. Scoping by user as well as
 * project means two different people dispatching "the same" configuration
 * a moment apart still get two runs, which is correct — nothing says they
 * meant to share one.
 *
 * The result is 25 lowercase alphanumeric characters starting with `c`,
 * matching the shape of a Prisma `cuid()` default. The `id` column is a
 * plain `String @id` with no format constraint, but every other run id in
 * this codebase looks like a cuid, and a deliberately different shape here
 * would be the kind of detail that invites a caller to (wrongly) start
 * validating run ids as one.
 */
export function deriveIdempotentRunId(input: {
	projectId: string;
	userId: string;
	idempotencyKey: string;
}): string {
	const digest = createHash("sha256")
		.update(`${input.projectId}\0${input.userId}\0${input.idempotencyKey}`)
		.digest("hex");
	return `c${digest.slice(0, 24)}`;
}
