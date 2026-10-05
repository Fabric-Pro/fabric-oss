/**
 * Keep the person's `gitlab-official` MCPConfig in step with what the GitLab
 * MCP capability probe found.
 *
 * The row is a TRANSPORT record: it names the official MCP endpoint and, for
 * connections made through the MCP registry, holds the dynamic client
 * registration that issued the person's GitLab credential. It never receives
 * a token from here — the credential lives on the person's GitLab connection
 * (`@repo/integrations/gitlab` connection service).
 */

export type SyncTx = {
	mCPServer: {
		findFirst: (args: unknown) => Promise<{ id: string } | null>;
	};
	mCPConfig: {
		findFirst: (args: unknown) => Promise<unknown>;
		create: (args: unknown) => Promise<unknown>;
		delete: (args: unknown) => Promise<unknown>;
	};
};

export type SyncInput = {
	userId: string;
	organizationId: string | null;
	capable: boolean;
	/**
	 * MCPConfig ids the person's GitLab connection depends on — the config
	 * whose client registration issued the stored credential. Never deleted.
	 */
	protectedConfigIds?: readonly string[];
};

/**
 * `kept-registration`: an incapable probe found a row it may not delete
 * because it holds a client registration (or is the credential's issuer).
 * `useOfficialMcp: false`, written by the same caller, routes traffic away
 * from it.
 */
export type SyncResult =
	| {
			ok: true;
			action:
				| "created"
				| "kept"
				| "deleted"
				| "kept-registration"
				| "noop";
	  }
	| { ok: false; reason: "server-not-seeded" };

/**
 * Create (capable) or remove (incapable) the `gitlab-official` MCPConfig for
 * this (userId, organizationId). An existing row is left as it is when the
 * probe is capable. Returns `server-not-seeded` when the catalog row is
 * missing so the caller can log it.
 *
 * Never deletes a row holding a client registration (`oauthClientId`) or one
 * listed in `protectedConfigIds`: deleting it would strand the credential it
 * issued, which can then never be refreshed again.
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

	const tenantFilter = input.organizationId
		? { organizationId: input.organizationId, userId: input.userId }
		: { organizationId: null, userId: input.userId };
	const existing = (await tx.mCPConfig.findFirst({
		where: { ...tenantFilter, mcpServerId: server.id },
		select: { id: true, oauthClientId: true },
	})) as { id: string; oauthClientId: string | null } | null;

	if (input.capable) {
		if (existing) {
			return { ok: true, action: "kept" };
		}
		await tx.mCPConfig.create({
			data: {
				userId: input.userId,
				organizationId: input.organizationId,
				mcpServerId: server.id,
				authType: "OAUTH2",
				enabled: true,
				needsReauth: false,
			},
		});
		return { ok: true, action: "created" };
	}

	if (!existing) {
		return { ok: true, action: "noop" };
	}
	if (
		existing.oauthClientId ||
		(input.protectedConfigIds ?? []).includes(existing.id)
	) {
		return { ok: true, action: "kept-registration" };
	}
	await tx.mCPConfig.delete({ where: { id: existing.id } });
	return { ok: true, action: "deleted" };
}
