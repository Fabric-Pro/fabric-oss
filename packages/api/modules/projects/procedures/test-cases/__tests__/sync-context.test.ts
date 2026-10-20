import type { TestCaseDetail } from "@repo/database";
import { runWithCorrelationId } from "@repo/utils/correlation-id";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ mirror: vi.fn() }));
vi.mock("@repo/temporal/test-case-context-sync", () => ({
	mirrorTestCaseToContext: mocks.mirror,
}));

import { mirrorTestCaseToContext } from "../sync-context";

const detail = { id: "example-case" } as TestCaseDetail;
const context = { userId: "example-user", organizationId: "example-org" };
beforeEach(() => vi.resetAllMocks());
describe("request-path context mirror", () => {
	it("passes the active request correlation memo to the shared mirror", async () => {
		await runWithCorrelationId("example-request", () =>
			mirrorTestCaseToContext(detail, context),
		);
		expect(mocks.mirror).toHaveBeenCalledExactlyOnceWith(detail, {
			...context,
			memo: { correlationId: "example-request" },
		});
	});
	it("leaves the memo undefined outside a request correlation context", async () => {
		await mirrorTestCaseToContext(detail, context);
		expect(mocks.mirror).toHaveBeenCalledExactlyOnceWith(detail, {
			...context,
			memo: undefined,
		});
	});
});
