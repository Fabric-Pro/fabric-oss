/**
 * Request-path mirror delegate for create/update/clone/bulk edit. Adds the active
 * request correlation memo before calling the shared @repo/temporal mirror.
 */
import type { TestCaseDetail } from "@repo/database";
import { mirrorTestCaseToContext as mirrorShared } from "@repo/temporal/test-case-context-sync";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";

export async function mirrorTestCaseToContext(
	detail: TestCaseDetail,
	ctx: { userId: string; organizationId?: string | null },
): Promise<void> {
	return mirrorShared(detail, {
		...ctx,
		...withCorrelationMemo({ memo: undefined }),
	});
}
