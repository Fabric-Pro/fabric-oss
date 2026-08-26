/**
 * The step resolver must wire the SHARED MCPConfig failure writer, exactly
 * like the PM adapter and the two API procedures. A caller that forgets it
 * degrades to REST on a dead grant while persisting nothing, so the next
 * activity refreshes the same revoked token again — the retry storm this
 * breaker exists to stop.
 *
 * The writer's own behaviour (diagnostics always, `needsReauth` only on a
 * provider rejection) is asserted directly in
 * `packages/integrations/__tests__/gitlab/refresh-failure-writer.test.ts`.
 * It can't be exercised through this file any more: the whole
 * `@repo/integrations/gitlab` barrel is stubbed here to keep the Prisma and
 * refresh-lock wiring out of the test, so what is verifiable — and what can
 * actually regress in this file — is the wiring itself.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockDb,
	createRefreshFailureWriterMock,
	refreshFailureWriter,
	resolveGitLabSourceMock,
} = vi.hoisted(() => {
	const refreshFailureWriter = vi.fn();
	return {
		mockDb: { mCPConfig: { update: vi.fn() } },
		createRefreshFailureWriterMock: vi.fn(() => refreshFailureWriter),
		refreshFailureWriter,
		resolveGitLabSourceMock: vi.fn(),
	};
});

vi.mock("@repo/database", () => ({
	db: mockDb,
}));

vi.mock("@repo/integrations/gitlab", () => ({
	createGitLabRefreshFailureWriter: createRefreshFailureWriterMock,
	getGitLabAccessToken: vi.fn(async () => null),
	refreshMcpConfigToken: vi.fn(),
	resolveGitLabSource: resolveGitLabSourceMock,
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (s: string) => s,
}));

import { resolveGitLabSourceForStep } from "../gitlab-resolver";

beforeEach(() => {
	vi.clearAllMocks();
	createRefreshFailureWriterMock.mockReturnValue(refreshFailureWriter);
});

describe("resolveGitLabSourceForStep — markRefreshFailure", () => {
	it("wires the shared failure writer, built over the package db client", async () => {
		resolveGitLabSourceMock.mockResolvedValueOnce(null);

		await resolveGitLabSourceForStep({ userId: "u1" });

		expect(createRefreshFailureWriterMock).toHaveBeenCalledWith(mockDb);
		const opts = resolveGitLabSourceMock.mock.calls[0]![0] as {
			markRefreshFailure?: unknown;
		};
		expect(opts.markRefreshFailure).toBe(refreshFailureWriter);
	});

	it("still wires the writer when the resolver ends up with no source", async () => {
		// The resolver returning null (GitLab not connected) must not be a
		// path where the callback is quietly dropped — the same opts object
		// is what a later connected run relies on.
		resolveGitLabSourceMock.mockResolvedValueOnce(null);

		const source = await resolveGitLabSourceForStep({
			userId: "u1",
			organizationId: "org-1",
		});

		expect(source).toBeNull();
		const opts = resolveGitLabSourceMock.mock.calls[0]![0] as {
			organizationId: string | null;
			markRefreshFailure?: unknown;
		};
		expect(opts.organizationId).toBe("org-1");
		expect(opts.markRefreshFailure).toBe(refreshFailureWriter);
	});
});
