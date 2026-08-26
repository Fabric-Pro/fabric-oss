/**
 * `resolveGitLabPMSource` must wire the shared writer that records an MCP
 * refresh failure — a caller that omits it degrades to REST while persisting
 * nothing, so the next request refreshes the same dead token again. These
 * tests drive the real writer (only `db` is faked) end-to-end through the
 * adapter; `refresh-failure-writer.test.ts` covers it in isolation.
 *
 * `MCPConfig.needsReauth` is a circuit breaker — a flagged config is
 * refused at MCP client creation and filtered out of tool discovery, and only
 * a fresh OAuth grant clears it — so it may only be set when GitLab
 * positively rejected the grant (`reauthRequired`). Diagnostics are written
 * either way, because losing transient-failure telemetry would hide a
 * recurring problem. They are only diagnostics: the writer updates the
 * MCPConfig row directly rather than through `recordRefreshFailure`, so no
 * threshold is evaluated and repeated transient failures never escalate to
 * `needsReauth` on their own — a genuinely dead grant is caught by the
 * permanent-rejection classification in `refreshGitLabToken` instead.
 *
 * Every one of those writes is conditional on the row still being
 * uncondemned, so they all land on `updateMany`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateMock, updateManyMock, resolveGitLabSourceMock } = vi.hoisted(
	() => ({
		updateMock: vi.fn(),
		updateManyMock: vi.fn(),
		resolveGitLabSourceMock: vi.fn(),
	}),
);

vi.mock("@repo/database", () => ({
	db: {
		// `update` is stubbed only so an accidental unconditional write shows
		// up as a called mock rather than a TypeError on an absent method.
		mCPConfig: { update: updateMock, updateMany: updateManyMock },
	},
	isPmServerIdKeySentinel: () => false,
	readPmServerIdKeySentinel: () => null,
}));
vi.mock("@repo/utils", () => ({
	decryptApiKey: (s: string) => s,
}));

// pm-adapter pulls its runtime helpers from the package barrel, which drags
// in the database refresh-lock wiring. None of them run on this path.
vi.mock("../../src/gitlab/index", () => ({
	executeGitLabTool: vi.fn(),
	getGitLabAccessToken: vi.fn(async () => null),
	refreshMcpConfigToken: vi.fn(),
}));

vi.mock("../../src/gitlab/source", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/gitlab/source")
	>("../../src/gitlab/source");
	return {
		...actual,
		resolveGitLabSource: resolveGitLabSourceMock,
	};
});

import { resolveGitLabPMSource } from "../../src/gitlab/pm-adapter";
import type { GitLabRefreshFailureWriter } from "../../src/gitlab/refresh-failure-writer";

// The real contract, not a local restatement of it: it pairs
// `reauthRequired` with the ciphertext the condemning write binds to, so a
// test here cannot construct an evidence-free condemnation the production
// callers can no longer express.
type MarkRefreshFailure = GitLabRefreshFailureWriter;

/**
 * Run the resolver once purely to capture the callback it wires, so the
 * writer can be exercised directly with both classifications.
 */
async function captureMarkRefreshFailure(): Promise<MarkRefreshFailure> {
	resolveGitLabSourceMock.mockResolvedValueOnce(null);
	await resolveGitLabPMSource({ userId: "u1", organizationId: null });
	const opts = resolveGitLabSourceMock.mock.calls[0]![0] as {
		markRefreshFailure?: MarkRefreshFailure;
	};
	if (!opts.markRefreshFailure) {
		throw new Error(
			"resolveGitLabPMSource did not wire markRefreshFailure",
		);
	}
	return opts.markRefreshFailure;
}

beforeEach(() => {
	vi.clearAllMocks();
	// Prisma's `updateMany` reports how many rows matched; `1` means the row
	// still holds the refresh token GitLab rejected and the breaker has not
	// tripped under us, so condemning it is sound. The zero-match races are
	// covered in `refresh-failure-writer.test.ts`.
	updateManyMock.mockResolvedValue({ count: 1 });
});

describe("resolveGitLabPMSource — markRefreshFailure", () => {
	it("records diagnostics WITHOUT condemning the credential on a transient failure", async () => {
		const mark = await captureMarkRefreshFailure();

		await mark({
			mcpConfigId: "cfg-transient",
			error: "GitLab token refresh failed: 503",
			reauthRequired: false,
			expectedRefreshToken: "enc:refresh",
		});

		expect(updateMock).not.toHaveBeenCalled();
		expect(updateManyMock).toHaveBeenCalledOnce();
		const arg = updateManyMock.mock.calls[0]![0];
		// Conditional on the row still being uncondemned: a breaker that trips
		// between the failure and this write makes it decline rather than
		// overwrite the diagnostics of the failure that tripped it.
		expect(arg.where).toEqual({ id: "cfg-transient", needsReauth: false });
		// The key must be absent entirely — writing `needsReauth: false` would
		// also clear a flag an earlier real revocation had set.
		expect(arg.data).not.toHaveProperty("needsReauth");
		expect(arg.data).toMatchObject({
			lastRefreshError: "GitLab token refresh failed: 503",
			refreshFailureCount: { increment: 1 },
		});
		expect(arg.data.lastRefreshFailedAt).toBeInstanceOf(Date);
	});

	it("sets needsReauth when GitLab positively rejected the grant", async () => {
		const mark = await captureMarkRefreshFailure();

		await mark({
			mcpConfigId: "cfg-revoked",
			error: "NEEDS_REAUTH",
			reauthRequired: true,
			expectedRefreshToken: "enc:rejected-refresh",
		});

		// Condemning is a CONDITIONAL write — it may only land while the row
		// still holds the token that was rejected — so it goes through
		// `updateMany`, carrying the diagnostics with it.
		expect(updateMock).not.toHaveBeenCalled();
		expect(updateManyMock).toHaveBeenCalledOnce();
		const arg = updateManyMock.mock.calls[0]![0];
		expect(arg.where).toEqual({
			id: "cfg-revoked",
			encryptedRefreshToken: "enc:rejected-refresh",
			needsReauth: false,
		});
		expect(arg.data).toMatchObject({
			needsReauth: true,
			lastRefreshError: "NEEDS_REAUTH",
			refreshFailureCount: { increment: 1 },
		});
		expect(arg.data.lastRefreshFailedAt).toBeInstanceOf(Date);
	});

	it("truncates the recorded error so a verbose provider message can't blow up the column", async () => {
		const mark = await captureMarkRefreshFailure();

		await mark({
			mcpConfigId: "cfg-transient",
			error: "x".repeat(2000),
			reauthRequired: false,
			expectedRefreshToken: "enc:refresh",
		});

		const arg = updateManyMock.mock.calls[0]![0];
		expect(arg.data.lastRefreshError).toHaveLength(500);
	});
});
