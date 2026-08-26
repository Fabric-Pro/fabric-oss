/**
 * Prompt vocabulary for the decision-contradiction judge.
 *
 * These two lines are the *semantics* the judge reasons with: an ACCEPTED
 * decision is a binding constraint the output must follow, and a REJECTED
 * option must not be reintroduced. The canonical wording lives in
 * `STATUS_AI_GUIDANCE` (packages/api/modules/projects/lib/
 * architecture-decision-context.ts) — the same guidance embedded with every
 * decision for RAG. It is COPIED here rather than imported because
 * `@repo/temporal` cannot depend on `@repo/api`. Keep the two in sync; if a
 * future refactor lifts that guidance into a lower shared package, import it
 * here instead of duplicating it.
 *
 * Only the two in-scope statuses appear — the pre-check considers ACCEPTED and
 * REJECTED decisions only.
 */
export const DECISION_JUDGE_STATUS_SEMANTICS: Record<
	"ACCEPTED" | "REJECTED",
	string
> = {
	ACCEPTED:
		"ACCEPTED — an active, agreed decision. Treat it as a binding constraint the output must follow. A contradiction means the output VIOLATES this decision.",
	REJECTED:
		"REJECTED — this option was considered and ruled out. It must NOT be proposed or reintroduced. A contradiction means the output REINTRODUCES this rejected option.",
};
