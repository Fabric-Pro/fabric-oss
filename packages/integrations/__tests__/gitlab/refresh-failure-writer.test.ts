/**
 * The one writer every `resolveGitLabSource` caller wires. `needsReauth` is
 * a circuit breaker — a flagged config is refused at MCP client creation and
 * filtered out of tool discovery, and only a fresh OAuth grant clears it —
 * so it may only be set when GitLab positively rejected the grant
 * (`reauthRequired`). Diagnostics are written either way, because losing
 * transient-failure telemetry would hide a recurring problem.
 *
 * Every write is conditional: `updateMany` gated on `needsReauth: false`, so
 * a breaker that trips between the evidence and the write makes the write
 * DECLINE rather than overwrite the diagnostics of the failure that tripped
 * it. A zero match is that race, not an error.
 *
 * The callback's argument type pairs the two: `reauthRequired` may only be
 * set alongside the ciphertext the condemning write binds to, so an
 * evidence-free condemnation no longer typechecks. The one test that still
 * exercises that runtime branch says so with `@ts-expect-error`.
 */
import { describe, expect, it, vi } from "vitest";
import { createGitLabRefreshFailureWriter } from "../../src/gitlab/refresh-failure-writer";

function makeWriter() {
	// Prisma's `updateMany` reports how many rows matched. `1` is the normal
	// case: the row still holds the refresh token GitLab rejected and no
	// concurrent failure has condemned it. Tests that need a miss override
	// with `mockResolvedValueOnce`.
	const updateMany = vi.fn().mockResolvedValue({ count: 1 });
	const writer = createGitLabRefreshFailureWriter({
		mCPConfig: { updateMany },
	});
	return { updateMany, writer };
}

describe("createGitLabRefreshFailureWriter", () => {
	it("records diagnostics WITHOUT condemning the credential on a transient failure", async () => {
		const { updateMany, writer } = makeWriter();

		await writer({
			mcpConfigId: "cfg-transient",
			error: "GitLab token refresh failed: 503",
			reauthRequired: false,
			expectedRefreshToken: "enc:refresh",
		});

		expect(updateMany).toHaveBeenCalledOnce();
		const arg = updateMany.mock.calls[0]![0];
		expect(arg.where).toEqual({
			id: "cfg-transient",
			needsReauth: false,
		});
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
		const { updateMany, writer } = makeWriter();

		await writer({
			mcpConfigId: "cfg-revoked",
			error: "NEEDS_REAUTH",
			reauthRequired: true,
			expectedRefreshToken: "enc:rejected-refresh",
		});

		// One write, not two: the diagnostics ride along with the conditional
		// update so a matched row records everything atomically.
		expect(updateMany).toHaveBeenCalledOnce();
		const arg = updateMany.mock.calls[0]![0];
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

	it("records diagnostics WITHOUT condemning when the row's refresh token has rotated away", async () => {
		// The race the conditional write exists for: GitLab rotates on every
		// exchange, so a parallel refresh can persist a live replacement
		// between the rejection and this write. Matching zero rows is the
		// proof it happened — the credential now on the row was never
		// rejected by anyone, and condemning it would hard-block a working
		// integration until the user reconnects.
		const { updateMany, writer } = makeWriter();
		// The condemning write misses; the diagnostics-only fallback lands,
		// which is what identifies this as a rotation rather than a
		// condemnation.
		updateMany.mockResolvedValueOnce({ count: 0 });
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		await writer({
			mcpConfigId: "cfg-raced",
			error: "NEEDS_REAUTH",
			reauthRequired: true,
			expectedRefreshToken: "enc:superseded-refresh",
		});

		expect(updateMany).toHaveBeenCalledTimes(2);
		const arg = updateMany.mock.calls[1]![0];
		expect(arg.where).toEqual({ id: "cfg-raced", needsReauth: false });
		// Absent, not `false` — a `false` here would clear a flag some
		// better-evidenced failure set in the same window.
		expect(arg.data).not.toHaveProperty("needsReauth");
		expect(arg.data).toMatchObject({
			lastRefreshError: "NEEDS_REAUTH",
			refreshFailureCount: { increment: 1 },
		});
		// A rejection that could not be acted on is worth a line.
		expect(consoleErrorSpy).toHaveBeenCalledOnce();
		consoleErrorSpy.mockRestore();
	});

	it("writes nothing further when a concurrent failure condemned the row first", async () => {
		// The other reading of a zero-match condemnation: not a rotation, but
		// a better-evidenced failure that already tripped the breaker. Its
		// diagnostics are the ones triage needs, so the fallback declines too
		// — and that is the guard working, not a failure to log.
		const { updateMany, writer } = makeWriter();
		updateMany.mockResolvedValue({ count: 0 });
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		await writer({
			mcpConfigId: "cfg-condemned",
			error: "NEEDS_REAUTH",
			reauthRequired: true,
			expectedRefreshToken: "enc:rejected-refresh",
		});

		// The condemning write and the diagnostics fallback, and nothing else
		// — no unconditional retry behind them.
		expect(updateMany).toHaveBeenCalledTimes(2);
		expect(consoleErrorSpy).not.toHaveBeenCalled();
		consoleErrorSpy.mockRestore();
	});

	it("declines the diagnostics write when the breaker tripped between the read and the write", async () => {
		// A transient failure that lost the same race. The row is condemned
		// now, so this write must not land: it would inflate the counter and
		// replace the diagnostics of the failure that actually tripped the
		// breaker.
		const { updateMany, writer } = makeWriter();
		updateMany.mockResolvedValue({ count: 0 });

		await writer({
			mcpConfigId: "cfg-condemned",
			error: "GitLab token refresh failed: 503",
			reauthRequired: false,
			expectedRefreshToken: "enc:refresh",
		});

		// Declining IS the outcome — no unconditional retry behind it.
		expect(updateMany).toHaveBeenCalledOnce();
		expect(updateMany.mock.calls[0]![0].where).toEqual({
			id: "cfg-condemned",
			needsReauth: false,
		});
	});

	it("binds a transient failure to the breaker instead of to a row version", async () => {
		// A 5xx is no evidence about any particular refresh token, so the
		// ciphertext stays out of the predicate even when the caller supplies
		// one. The breaker is the only axis a transient failure races on.
		const { updateMany, writer } = makeWriter();

		await writer({
			mcpConfigId: "cfg-transient",
			error: "GitLab token refresh failed: 503",
			reauthRequired: false,
			expectedRefreshToken: "enc:refresh",
		});

		expect(updateMany).toHaveBeenCalledOnce();
		expect(updateMany.mock.calls[0]![0].where).not.toHaveProperty(
			"encryptedRefreshToken",
		);
	});

	it("still condemns a row that posted no token, bound to the breaker alone", async () => {
		// No longer reachable through the typed signature — `reauthRequired`
		// must travel with the `expectedRefreshToken` it is bound to, and the
		// `@ts-expect-error` below fails the build if that constraint is ever
		// relaxed. The runtime branch survives for untyped callers: dropping
		// the strike would fail open into the retry storm. Nothing was posted,
		// so no rotation can have raced us and there is no version to bind to.
		// The breaker guard still applies: a row condemned under us is already
		// behind it.
		const { updateMany, writer } = makeWriter();

		await writer(
			// @ts-expect-error — `reauthRequired: true` requires `expectedRefreshToken`
			{
				mcpConfigId: "cfg-no-token",
				error: "NEEDS_REAUTH",
				reauthRequired: true,
			},
		);

		expect(updateMany).toHaveBeenCalledOnce();
		const arg = updateMany.mock.calls[0]![0];
		expect(arg.where).toEqual({ id: "cfg-no-token", needsReauth: false });
		expect(arg.data).toMatchObject({ needsReauth: true });
	});

	it("truncates the recorded error so a verbose provider message can't blow up the column", async () => {
		const { updateMany, writer } = makeWriter();

		await writer({
			mcpConfigId: "cfg-transient",
			error: "x".repeat(2000),
			reauthRequired: false,
			expectedRefreshToken: "enc:refresh",
		});

		expect(updateMany.mock.calls[0]![0].data.lastRefreshError).toHaveLength(
			500,
		);
	});

	it("rejects when the conditional write fails, leaving the decision to the caller", async () => {
		// `resolveGitLabSource` swallows a writer rejection so a DB outage
		// can't block the REST fallback. The writer itself must therefore
		// surface the failure rather than absorbing it silently.
		const updateMany = vi.fn().mockRejectedValue(new Error("db down"));
		const writer = createGitLabRefreshFailureWriter({
			mCPConfig: { updateMany },
		});

		await expect(
			writer({
				mcpConfigId: "cfg-1",
				error: "NEEDS_REAUTH",
				reauthRequired: true,
				expectedRefreshToken: "enc:refresh",
			}),
		).rejects.toThrow("db down");
	});
});
