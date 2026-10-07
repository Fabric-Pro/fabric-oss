import type { ChatGptPlanSourceKey } from "@repo/database";
import { chatGptPlanLockKey } from "@repo/database/prisma/queries/lib/refresh-lock";

/**
 * One ChatGPT plan a call can run on (Fizzy #2770): a member's own plan, or
 * an account the organization connected for its shared work. Every org
 * source carries the organization it was read under, so each later read and
 * write by account id filters on it again.
 */
export type PlanSourceRef =
	| { kind: "user"; userId: string }
	| { kind: "org"; organizationId: string; accountId: string };

/**
 * An opaque, stable name for a source — `user:<id>` or `org:<id>` — for logs,
 * caches and the exclusion list an agent sends back after a refusal. Never a
 * way to reach a source by itself: an org key is honoured only against the
 * caller's own organization.
 */
export function planSourceKey(ref: PlanSourceRef): string {
	return ref.kind === "user" ? `user:${ref.userId}` : `org:${ref.accountId}`;
}

/** The row in `ChatGptPlanSourceState` that remembers this source's spent window. */
export function planSourceStateKey(ref: PlanSourceRef): ChatGptPlanSourceKey {
	return ref.kind === "user"
		? { sourceKind: "USER", sourceId: ref.userId }
		: { sourceKind: "ORG", sourceId: ref.accountId };
}

/**
 * The refresh lock for a source's sign-in. A member's own plan keeps the
 * phase-1 key byte for byte, so a process still running phase-1 code and
 * one running this serialize on the same lock during a rolling deploy.
 */
export function chatGptPlanSourceLockKey(ref: PlanSourceRef): string {
	return ref.kind === "user"
		? chatGptPlanLockKey(ref.userId)
		: `chatgpt-plan-org:${ref.accountId}`;
}

/** What a log line may say about a source: ids only. */
export function planSourceLogFields(
	ref: PlanSourceRef,
): Record<string, string> {
	return ref.kind === "user"
		? { userId: ref.userId }
		: { organizationId: ref.organizationId, planAccountId: ref.accountId };
}
