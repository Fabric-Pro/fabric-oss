export type SyncTokenBundle = {
	encryptedAccessToken: string;
	accessTokenHash: string;
	encryptedRefreshToken: string | null;
	/**
	 * Optional: omit (or pass `undefined`) to leave the existing
	 * `tokenExpiresAt` column untouched on the update branch. The create
	 * branch defaults to `null` when omitted (back-compat).
	 *
	 * This matters for callers like recheck which do NOT carry an authoritative
	 * expiry value — passing `null` here would otherwise clobber a healthy
	 * expiry and break the next refresh.
	 */
	tokenExpiresAt?: Date | null;
};

export type SyncTx = {
	mCPServer: {
		findFirst: (args: unknown) => Promise<{ id: string } | null>;
	};
	mCPConfig: {
		findFirst: (
			args: unknown,
		) => Promise<{ id: string; needsReauth: boolean } | null>;
		create: (args: unknown) => Promise<unknown>;
		update: (args: unknown) => Promise<unknown>;
		delete: (args: unknown) => Promise<unknown>;
	};
};

export type SyncInput = {
	userId: string;
	organizationId: string | null;
	capable: boolean;
	tokenBundle: SyncTokenBundle;
	/**
	 * Clear the row's circuit-breaker state on the update branch
	 * (`needsReauth`, `status`, `refreshFailureCount`, `lastRefreshFailedAt`,
	 * `lastRefreshError`, `consecutiveFailures`). Defaults to `false`.
	 *
	 * Pass `true` ONLY when the caller has just obtained a FRESH OAuth grant
	 * from the user. Clearing `needsReauth` without one resurrects a
	 * credential whose refresh token is still dead: the breaker is ENFORCED
	 * (a flagged config is refused at MCP client creation, filtered out of
	 * tool discovery and blocked from refreshing) and nothing but a new grant
	 * may lift it. A capability probe that reuses the existing credential is
	 * not a new grant, so it must leave the breaker exactly as it found it.
	 */
	resetBreaker?: boolean;
};

/**
 * Discriminated result so callers can detect (and log) the unseeded-env
 * case instead of treating it as a silent success.
 *
 * `kept-condemned` is the one action that reports a write DECLINED: an
 * incapable probe found a condemned row and the caller had no authority to
 * clear its breaker, so the row was left alone rather than deleted.
 */
export type SyncResult =
	| {
			ok: true;
			action:
				| "created"
				| "updated"
				| "deleted"
				| "kept-condemned"
				| "noop";
	  }
	| { ok: false; reason: "server-not-seeded" };

/**
 * The circuit-breaker columns a fresh grant clears, and nothing else. Shared by
 * the capability sync's update branch and `resetGitlabOfficialMcpBreaker` so
 * the two paths cannot drift on what "reset the breaker" means.
 */
function buildOfficialUpdateData(
	tokenBundle: SyncTokenBundle,
	resetBreaker: boolean,
): Record<string, unknown> {
	// Only set tokenExpiresAt when the caller explicitly passed it; omitting
	// leaves the column intact (see SyncTokenBundle.tokenExpiresAt JSDoc).
	const data: Record<string, unknown> = {
		encryptedAccessToken: tokenBundle.encryptedAccessToken,
		accessTokenHash: tokenBundle.accessTokenHash,
		encryptedRefreshToken: tokenBundle.encryptedRefreshToken,
	};
	if (resetBreaker) {
		// A fresh grant is a full recovery signal: reset the whole
		// circuit-breaker state, not just the flag. Leaving
		// refreshFailureCount at its tripped value would re-trip the breaker
		// on the next single transient failure. Mirrors updateMcpConfigTokens
		// and the primary-config reset in gitlab-token.ts. Gated because
		// callers without a new grant (the capability recheck) must not
		// resurrect the row — see SyncInput.resetBreaker.
		data.needsReauth = false;
		data.status = "HEALTHY";
		data.refreshFailureCount = 0;
		data.lastRefreshFailedAt = null;
		data.lastRefreshError = null;
		data.consecutiveFailures = 0;
	}
	if (tokenBundle.tokenExpiresAt !== undefined) {
		data.tokenExpiresAt = tokenBundle.tokenExpiresAt;
	}
	return data;
}

/**
 * Create / update / delete the `gitlab-official` MCPConfig for this
 * (userId, organizationId) pair so it reflects the probe result.
 * Returns `{ ok: false, reason: "server-not-seeded" }` when the
 * `gitlab-official` MCPServer row is missing so the caller can log
 * and surface the unseeded-env case in telemetry.
 */
export async function syncGitlabOfficialMcpConfig(
	tx: SyncTx,
	input: SyncInput,
): Promise<SyncResult> {
	const server = await tx.mCPServer.findFirst({
		where: { key: "gitlab-official" },
		select: { id: true },
	});
	if (!server) {
		return { ok: false, reason: "server-not-seeded" };
	}

	const existing = await tx.mCPConfig.findFirst({
		where: {
			userId: input.userId,
			organizationId: input.organizationId,
			mcpServerId: server.id,
		},
		// `needsReauth` gates the delete branch below — a caller without reset
		// authority may not erase a condemned row.
		select: { id: true, needsReauth: true },
	});

	if (input.capable) {
		if (existing) {
			await tx.mCPConfig.update({
				where: { id: existing.id },
				data: buildOfficialUpdateData(
					input.tokenBundle,
					Boolean(input.resetBreaker),
				),
			});
			return { ok: true, action: "updated" };
		}
		// The create branch needs no `resetBreaker` gate: a brand-new row has
		// no breaker state to resurrect, and the columns it doesn't name
		// (status, refreshFailureCount, consecutiveFailures, lastRefresh*)
		// take their clean schema defaults. `needsReauth: false` here just
		// restates that default.
		await tx.mCPConfig.create({
			data: {
				userId: input.userId,
				organizationId: input.organizationId,
				mcpServerId: server.id,
				authType: "OAUTH2",
				encryptedAccessToken: input.tokenBundle.encryptedAccessToken,
				accessTokenHash: input.tokenBundle.accessTokenHash,
				encryptedRefreshToken: input.tokenBundle.encryptedRefreshToken,
				tokenExpiresAt: input.tokenBundle.tokenExpiresAt ?? null,
				enabled: true,
				needsReauth: false,
			},
		});
		return { ok: true, action: "created" };
	}

	if (existing) {
		if (existing.needsReauth && !input.resetBreaker) {
			// Deleting a condemned row would erase breaker state this caller
			// has no authority to clear — and erase it far more thoroughly
			// than the update branch's guard prevents: the next capable probe
			// recreates the row clean (`needsReauth: false`), so the
			// delete/recreate pair launders a breaker only a fresh grant may
			// lift. Both probes here can be running on the EXISTING, dead
			// credential.
			//
			// Leaving the row costs nothing: while flagged it is refused at
			// MCP client creation, filtered out of tool discovery and blocked
			// from refreshing, and it is the WorkflowIntegration's
			// `useOfficialMcp: false` — written by the same caller, in the same
			// transaction — that actually routes traffic away from it.
			return { ok: true, action: "kept-condemned" };
		}
		await tx.mCPConfig.delete({ where: { id: existing.id } });
		return { ok: true, action: "deleted" };
	}
	return { ok: true, action: "noop" };
}

/**
 * Discriminated result for `resetGitlabOfficialMcpBreaker`. `noop` means there
 * was no `gitlab-official` row to recover, which is the common case.
 */
export type ResetOfficialBreakerResult =
	| { ok: true; action: "reset" | "noop" }
	| { ok: false; reason: "server-not-seeded" };

/**
 * Credential-only recovery for the `gitlab-official` row: rewrite its stored
 * token and clear its circuit-breaker state, making NO capability decision —
 * it never creates a row and never deletes one.
 *
 * `syncGitlabOfficialMcpConfig` answers "is the official MCP server usable",
 * which requires an authoritative probe. This answers "does the user hold a
 * live grant", which does not: a completed authorization-code exchange is
 * conclusive about the CREDENTIAL however the unrelated capability probe went.
 * Fusing the two left a real hole — a genuine reconnect whose probe timed out
 * skipped the sync entirely, so a condemned official row kept its breaker and
 * its dead token. `reconcile` then refuses (it declines while EITHER row is
 * condemned) and the capability recheck cannot clear it either (no reset
 * authority), stranding the user until another OAuth flow happened to coincide
 * with a working probe.
 *
 * Creating a row is deliberately out of scope: that would assert the official
 * server is usable, which is exactly the capability claim a non-authoritative
 * probe cannot make.
 */
export async function resetGitlabOfficialMcpBreaker(
	tx: SyncTx,
	input: {
		userId: string;
		organizationId: string | null;
		tokenBundle: SyncTokenBundle;
	},
): Promise<ResetOfficialBreakerResult> {
	const server = await tx.mCPServer.findFirst({
		where: { key: "gitlab-official" },
		select: { id: true },
	});
	if (!server) {
		return { ok: false, reason: "server-not-seeded" };
	}

	const existing = await tx.mCPConfig.findFirst({
		where: {
			userId: input.userId,
			organizationId: input.organizationId,
			mcpServerId: server.id,
		},
		// `needsReauth` is selected to keep the row shape `SyncTx` promises;
		// this path deliberately does not branch on it (see below).
		select: { id: true, needsReauth: true },
	});
	if (!existing) {
		return { ok: true, action: "noop" };
	}

	// Applied whether or not the row is currently condemned: the new token is
	// the right one either way, and the reset columns are already what a
	// healthy row holds.
	await tx.mCPConfig.update({
		where: { id: existing.id },
		data: buildOfficialUpdateData(input.tokenBundle, true),
	});
	return { ok: true, action: "reset" };
}
