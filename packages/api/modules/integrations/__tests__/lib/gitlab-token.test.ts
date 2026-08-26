import {
	advisoryObjectKey,
	mcpConfigLockKey,
	REFRESH_ADVISORY_CLASS,
} from "@repo/database/prisma/queries/lib/refresh-lock-key";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/utils", () => ({
	encryptApiKey: (v: string) => `enc_${v}`,
	decryptApiKey: (v: string) => v.replace("enc_", ""),
	hashApiKey: (v: string) => `hash_${v}`,
}));

// Mock heavy symbols on @repo/integrations/gitlab (probeGitLabMcp does network
// I/O we don't want in unit tests). We use `vi.importActual` on the
// `oauth-refresh` submodule so `GitLabReauthRequiredError` is the REAL class —
// keeping `instanceof` identity aligned with whatever path the SUT (or any
// future helper) imports it from. The full `@repo/integrations/gitlab` barrel
// can't be `importActual`'d here because it transitively imports
// `@repo/database` (Prisma client not generated in this test env), so we reach
// into the leaf module directly via a relative path.
const probeGitLabMcpMock = vi.fn();
vi.mock("@repo/integrations/gitlab", async () => {
	// Pull `GitLabReauthRequiredError` from the real leaf module so its
	// constructor identity matches the SUT (any `instanceof` check stays
	// aligned regardless of which path imports it). We can't `importActual`
	// the whole `@repo/integrations/gitlab` barrel here because it
	// transitively imports `@repo/database` (Prisma client not generated in
	// this test env). The factory runs in a synthetic mock-context, so
	// relative paths don't resolve reliably — use an absolute file URL via
	// `import.meta.url` to point at the leaf module.
	const { fileURLToPath } = await import("node:url");
	const path = await import("node:path");
	const here = path.dirname(fileURLToPath(import.meta.url));
	const oauthRefreshPath = path.resolve(
		here,
		"../../../../../integrations/src/gitlab/oauth-refresh.ts",
	);
	const oauthRefresh =
		await vi.importActual<typeof import("@repo/integrations/gitlab")>(
			oauthRefreshPath,
		);
	return {
		probeGitLabMcp: probeGitLabMcpMock,
		GitLabReauthRequiredError: oauthRefresh.GitLabReauthRequiredError,
	};
});

describe("getValidGitLabToken / markNeedsReauth", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.unstubAllGlobals();
		// Default probe mock: not capable (safe default — keeps focus on token refresh logic).
		probeGitLabMcpMock.mockResolvedValue({
			capable: false,
			status: "not-found",
			httpStatus: 404,
		});
	});

	/** The `where` shape an evidence-bound condemnation issues. */
	type ReauthWhere = {
		id: string;
		needsReauth: boolean;
		encryptedAccessToken?: string;
		encryptedRefreshToken?: string;
	};

	type ReauthUpdateMany = (args: {
		where: ReauthWhere;
		data: { needsReauth: true };
	}) => Promise<{ count: number }>;

	type McpConfigRowState = {
		id: string;
		encryptedAccessToken: string | null;
		encryptedRefreshToken: string | null;
		needsReauth: boolean;
	};

	/**
	 * An in-memory MCPConfig row whose `updateMany` actually EVALUATES the
	 * predicate instead of returning a canned count. The condemnation is
	 * conditional now, so "did it land" is a property of the row's current
	 * contents — a mock that always answered `{ count: 1 }` would pass just as
	 * happily with the guard deleted.
	 *
	 * Two copies, because "written inside a transaction" and "survived one" are
	 * different facts. `row` is what the open transaction sees — its own writes
	 * are visible to its later statements. `committed` is what everyone else
	 * sees, and only `freshTx`'s `commit()` moves a write across. So a callback
	 * that throws leaves `committed` untouched, exactly as Prisma rolls the
	 * write back, and a test that asserts on `committed` cannot be fooled by an
	 * in-callback mutation the database would have discarded.
	 */
	function liveMcpConfigRow(initial: McpConfigRowState) {
		const row = { ...initial };
		const committed = { ...initial };
		const updateMany: ReauthUpdateMany = async ({ where, data }) => {
			const matches =
				where.id === row.id &&
				where.needsReauth === row.needsReauth &&
				(where.encryptedAccessToken === undefined ||
					where.encryptedAccessToken === row.encryptedAccessToken) &&
				(where.encryptedRefreshToken === undefined ||
					where.encryptedRefreshToken === row.encryptedRefreshToken);
			if (!matches) {
				return { count: 0 };
			}
			Object.assign(row, data);
			return { count: 1 };
		};
		return {
			row,
			committed,
			updateMany,
			/** Promote a write this transaction issued. Commit path only. */
			commitWrite: (data: Partial<McpConfigRowState>) => {
				Object.assign(committed, data);
			},
			/**
			 * A write from ANOTHER, already-committed transaction — a reconnect
			 * landing while this refresh is in flight. Both copies move.
			 */
			externalCommit: (data: Partial<McpConfigRowState>) => {
				Object.assign(row, data);
				Object.assign(committed, data);
			},
		};
	}

	type LiveMcpConfigRow = ReturnType<typeof liveMcpConfigRow>;

	function freshTx(opts?: {
		mcpRow?: unknown;
		wiRow?: unknown;
		mcpConfigStore?: LiveMcpConfigRow;
		workflowIntegrationUpdate?: (args: unknown) => Promise<unknown>;
	}) {
		// A write issued inside a Prisma interactive transaction is durable only
		// if the callback RESOLVES; a throw rolls the whole transaction back.
		// These doubles model that — every write records its effect as PENDING,
		// and only `commit()` (which the `$transaction` doubles call on a
		// resolved callback, never on a rejected one) makes it observable. An
		// eager fake reports a condemnation as persisted even where the real
		// database threw it away, which is precisely the bug under test.
		const pending: Array<() => void> = [];
		const committedWrites: string[] = [];
		let committedWiSettings: unknown = null;
		const journal = (label: string, effect?: () => void) => {
			pending.push(() => {
				committedWrites.push(label);
				effect?.();
			});
		};
		const runUpdateMany: ReauthUpdateMany =
			opts?.mcpConfigStore?.updateMany ?? (async () => ({ count: 1 }));

		return {
			// The advisory lock is taken by DEFAULT now (it used to require an
			// explicit `opts.prisma`, which the one production caller never
			// passed). A tx double without $executeRaw would therefore throw
			// instead of exercising the locked path these tests describe.
			$executeRaw: vi.fn().mockResolvedValue(1),
			mCPServer: {
				findFirst: vi
					.fn()
					.mockResolvedValue({ id: "mcp_server_gitlab" }),
			},
			mCPConfig: {
				findFirst: vi.fn().mockResolvedValue(opts?.mcpRow ?? null),
				create: vi.fn(async (_args: unknown) => {
					journal("mCPConfig.create");
					return {};
				}),
				update: vi.fn(async (_args: unknown) => {
					journal("mCPConfig.update");
					return {};
				}),
				delete: vi.fn(async (_args: unknown) => {
					journal("mCPConfig.delete");
					return {};
				}),
				// Default: the condemnation matched its row. `{ count: 0 }`
				// now MEANS something — the row moved on under the writer —
				// so it is opted into per test rather than being the default.
				updateMany: vi.fn<ReauthUpdateMany>(async (args) => {
					const result = await runUpdateMany(args);
					// A zero-match UPDATE wrote nothing, so a commit has
					// nothing to promote.
					if (result.count > 0) {
						journal("mCPConfig.updateMany", () =>
							opts?.mcpConfigStore?.commitWrite(args.data),
						);
					}
					return result;
				}),
			},
			workflowIntegration: {
				findFirst: vi.fn().mockResolvedValue(opts?.wiRow ?? null),
				create: vi.fn(async (_args: unknown) => {
					journal("workflowIntegration.create");
					return {};
				}),
				update: vi.fn(async (args: unknown) => {
					const result = opts?.workflowIntegrationUpdate
						? await opts.workflowIntegrationUpdate(args)
						: {};
					const written = (args as { data?: { settings?: unknown } })
						?.data?.settings;
					journal("workflowIntegration.update", () => {
						committedWiSettings = written ?? null;
					});
					return result;
				}),
			},
			/** Promotes every buffered write. Only a COMMITTED transaction calls it. */
			commit: () => {
				for (const apply of pending.splice(0)) {
					apply();
				}
			},
			/** Labels of the writes that survived the transaction, in order. */
			committedWrites: () => [...committedWrites],
			/** `WorkflowIntegration.settings` as it stands AFTER commit. */
			committedWiSettings: () => committedWiSettings,
		};
	}

	type TxShape = ReturnType<typeof freshTx>;

	function dbFor(opts: {
		mcpRow?: unknown;
		wiRow?: unknown;
		mcpConfigStore?: LiveMcpConfigRow;
		workflowIntegrationUpdate?: (args: unknown) => Promise<unknown>;
	}): {
		db: {
			$transaction: (
				cb: (t: TxShape) => Promise<unknown>,
			) => Promise<unknown>;
			mCPConfig: TxShape["mCPConfig"];
			workflowIntegration: TxShape["workflowIntegration"];
		};
		tx: TxShape;
	} {
		const tx = freshTx(opts);
		return {
			db: {
				mCPConfig: tx.mCPConfig,
				workflowIntegration: tx.workflowIntegration,
				$transaction: vi.fn(
					async (cb: (t: TxShape) => Promise<unknown>) => {
						const result = await cb(tx);
						// Reached only when the callback RESOLVED. A rejection
						// propagates from the await above and every buffered
						// write is dropped — Prisma's rollback, modelled.
						tx.commit();
						return result;
					},
				),
			},
			tx,
		};
	}

	it("returns the current access token when not expiring", async () => {
		const { db } = dbFor({
			mcpRow: {
				id: "mcp_1",
				encryptedAccessToken: "enc_alive",
				encryptedRefreshToken: "enc_rtok",
				tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
				needsReauth: false,
			},
		});
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		const { getValidGitLabToken } = await import("../../lib/gitlab-token");
		const token = await getValidGitLabToken(db as never, {
			userId: "u1",
			organizationId: null,
		});

		expect(token).toBe("alive");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("refreshes and dual-writes when expiring; returns the new token", async () => {
		const expired = new Date(Date.now() + 10 * 1000);
		const { db, tx } = dbFor({
			mcpRow: {
				id: "mcp_1",
				encryptedAccessToken: "enc_stale",
				encryptedRefreshToken: "enc_rtok",
				tokenExpiresAt: expired,
				needsReauth: false,
			},
			wiRow: {
				id: "wi_1",
				credentials: "",
				settings: {
					gitlabUserId: 42,
					gitlabUsername: "alice",
					gitlabName: "Alice",
					gitlabAvatarUrl: null,
				},
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					access_token: "renewed",
					refresh_token: "rtok-2",
					expires_in: 7200,
					created_at: Math.floor(Date.now() / 1000),
					scope: "api read_user",
					token_type: "bearer",
				}),
			}),
		);

		const { getValidGitLabToken } = await import("../../lib/gitlab-token");
		const token = await getValidGitLabToken(db as never, {
			userId: "u1",
			organizationId: null,
		});

		expect(token).toBe("renewed");
		expect(tx.mCPConfig.update).toHaveBeenCalledTimes(1);
		expect(tx.workflowIntegration.update).toHaveBeenCalledTimes(1);
	});

	it("throws GitLabReauthRequiredError when refresh returns invalid_grant", async () => {
		const expired = new Date(Date.now() + 10 * 1000);
		const { db, tx } = dbFor({
			mcpRow: {
				id: "mcp_1",
				encryptedAccessToken: "enc_stale",
				encryptedRefreshToken: "enc_dead",
				tokenExpiresAt: expired,
				needsReauth: false,
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 400,
				json: async () => ({ error: "invalid_grant" }),
			}),
		);

		const { getValidGitLabToken, GitLabReauthRequiredError } = await import(
			"../../lib/gitlab-token"
		);
		await expect(
			getValidGitLabToken(db as never, {
				userId: "u1",
				organizationId: null,
			}),
		).rejects.toBeInstanceOf(GitLabReauthRequiredError);

		// Both rows marked needsReauth=true via markNeedsReauth. The MCPConfig
		// write names the row AND the refresh-token ciphertext GitLab
		// rejected: it used to be an unconditional update keyed on the tenant
		// tuple alone, which condemned whatever the row held by the time it
		// landed — including a credential a reconnect had just installed.
		expect(tx.mCPConfig.updateMany).toHaveBeenCalledWith({
			where: {
				id: "mcp_1",
				encryptedRefreshToken: "enc_dead",
				needsReauth: false,
			},
			data: { needsReauth: true },
		});
	});

	it("throws GitLabReauthRequiredError when refresh returns invalid_token", async () => {
		// `invalid_token` is the second permanent signal the shared
		// `refreshGitLabToken` classifies on. This local implementation must
		// agree with it, or the same GitLab response condemns the credential
		// on one path and reads as transient on the other.
		const expired = new Date(Date.now() + 10 * 1000);
		const { db, tx } = dbFor({
			mcpRow: {
				id: "mcp_1",
				encryptedAccessToken: "enc_stale",
				encryptedRefreshToken: "enc_dead",
				tokenExpiresAt: expired,
				needsReauth: false,
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 401,
				json: async () => ({ error: "invalid_token" }),
			}),
		);

		const { getValidGitLabToken, GitLabReauthRequiredError } = await import(
			"../../lib/gitlab-token"
		);
		await expect(
			getValidGitLabToken(db as never, {
				userId: "u1",
				organizationId: null,
			}),
		).rejects.toBeInstanceOf(GitLabReauthRequiredError);

		expect(tx.mCPConfig.updateMany).toHaveBeenCalledWith({
			where: {
				id: "mcp_1",
				encryptedRefreshToken: "enc_dead",
				needsReauth: false,
			},
			data: { needsReauth: true },
		});
	});

	it("condemns on an OAuth error body returned with HTTP 200", async () => {
		// GitLab can answer 200 with `{ error: "invalid_grant" }`. Reading
		// only `res.ok` meant the dead grant sailed through and
		// `access_token: undefined` got encrypted and persisted.
		const expired = new Date(Date.now() + 10 * 1000);
		const { db, tx } = dbFor({
			mcpRow: {
				id: "mcp_1",
				encryptedAccessToken: "enc_stale",
				encryptedRefreshToken: "enc_dead",
				tokenExpiresAt: expired,
				needsReauth: false,
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({
					error: "invalid_grant",
					error_description:
						"The provided authorization grant is invalid",
				}),
			}),
		);

		const { getValidGitLabToken, GitLabReauthRequiredError } = await import(
			"../../lib/gitlab-token"
		);
		await expect(
			getValidGitLabToken(db as never, {
				userId: "u1",
				organizationId: null,
			}),
		).rejects.toBeInstanceOf(GitLabReauthRequiredError);

		expect(tx.mCPConfig.updateMany).toHaveBeenCalledWith({
			where: {
				id: "mcp_1",
				encryptedRefreshToken: "enc_dead",
				needsReauth: false,
			},
			data: { needsReauth: true },
		});
		// The bogus token never reached the row.
		expect(tx.mCPConfig.update).not.toHaveBeenCalled();
	});

	it("does NOT condemn on a 403 with no OAuth error code", async () => {
		// A bare HTTP status is not evidence about the user's grant — it can
		// be instance policy, an auth ban, or a proxy in front of a
		// self-hosted instance. Same rule as the shared classifier.
		const expired = new Date(Date.now() + 10 * 1000);
		const { db, tx } = dbFor({
			mcpRow: {
				id: "mcp_1",
				encryptedAccessToken: "enc_stale",
				encryptedRefreshToken: "enc_r",
				tokenExpiresAt: expired,
				needsReauth: false,
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 403,
				json: async () => ({ error: "insufficient_scope" }),
			}),
		);

		const { getValidGitLabToken, GitLabReauthRequiredError } = await import(
			"../../lib/gitlab-token"
		);
		const err = await getValidGitLabToken(db as never, {
			userId: "u1",
			organizationId: null,
		}).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(GitLabReauthRequiredError);
		expect(tx.mCPConfig.updateMany).not.toHaveBeenCalled();
	});

	it("condemns the row while it still holds the refresh token GitLab rejected", async () => {
		// The normal case, asserted on the COMMITTED row rather than on the
		// call shape: making the write conditional must not have turned the
		// ordinary condemnation into a no-op.
		const stored = liveMcpConfigRow({
			id: "mcp_1",
			encryptedAccessToken: "enc_stale",
			encryptedRefreshToken: "enc_dead",
			needsReauth: false,
		});
		const { db } = dbFor({
			mcpRow: {
				...stored.row,
				tokenExpiresAt: new Date(Date.now() + 10 * 1000),
			},
			mcpConfigStore: stored,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 400,
				json: async () => ({ error: "invalid_grant" }),
			}),
		);

		const { getValidGitLabToken, GitLabReauthRequiredError } = await import(
			"../../lib/gitlab-token"
		);
		await expect(
			getValidGitLabToken(db as never, {
				userId: "u1",
				organizationId: null,
			}),
		).rejects.toBeInstanceOf(GitLabReauthRequiredError);

		// `committed`, not `row`: the write only counts if it outlived the
		// transaction the locked refresh path performs it in.
		expect(stored.committed.needsReauth).toBe(true);
	});

	it("commits the condemnation before the reauth error leaves the transaction", async () => {
		// The defect this shape exists to prevent. The locked refresh path
		// condemns the credential and then fails, and while that failure was a
		// `throw` from inside the `$transaction` callback, Prisma rolled the
		// transaction back and took BOTH condemnation writes with it. The
		// caller still saw the right error, so nothing looked wrong — but the
		// row stayed clean and the dead grant was posted again on the very next
		// call, which is the retry loop the breaker exists to stop. The error
		// may only be raised once the transaction has committed.
		const stored = liveMcpConfigRow({
			id: "mcp_1",
			encryptedAccessToken: "enc_stale",
			encryptedRefreshToken: "enc_dead",
			needsReauth: false,
		});
		const { db, tx } = dbFor({
			mcpRow: {
				...stored.row,
				tokenExpiresAt: new Date(Date.now() + 10 * 1000),
			},
			wiRow: { id: "wi_1", settings: { gitlabUsername: "exampleuser" } },
			mcpConfigStore: stored,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 400,
				json: async () => ({ error: "invalid_grant" }),
			}),
		);

		const { getValidGitLabToken, GitLabReauthRequiredError } = await import(
			"../../lib/gitlab-token"
		);
		await expect(
			getValidGitLabToken(db as never, {
				userId: "u1",
				organizationId: null,
			}),
		).rejects.toBeInstanceOf(GitLabReauthRequiredError);

		// Both writes survived: the enforced MCPConfig breaker and the
		// WorkflowIntegration mirror the legacy readers go by.
		expect(tx.committedWrites()).toEqual([
			"mCPConfig.updateMany",
			"workflowIntegration.update",
		]);
		expect(stored.committed.needsReauth).toBe(true);
		expect(tx.committedWiSettings()).toMatchObject({ needsReauth: true });
	});

	it("rolls back — and still propagates — a failure that is not a reauth verdict", async () => {
		// The other half of the same rule, and the reason the callback still
		// contains a bare `throw`. A dropped connection or a half-written
		// dual-write carries no verdict worth preserving, so the transaction
		// must abort and take its partial writes with it. Here the refresh
		// SUCCEEDS and the persist dies on its last statement, after the
		// MCPConfig token columns have already been written.
		const { db, tx } = dbFor({
			mcpRow: {
				id: "mcp_1",
				encryptedAccessToken: "enc_stale",
				encryptedRefreshToken: "enc_rtok",
				tokenExpiresAt: new Date(Date.now() + 10 * 1000),
				needsReauth: false,
			},
			wiRow: {
				id: "wi_1",
				credentials: "",
				settings: {
					gitlabUserId: 42,
					gitlabUsername: "alice",
					gitlabName: "Alice",
					gitlabAvatarUrl: null,
				},
			},
			workflowIntegrationUpdate: async () => {
				throw new Error("connection reset by peer");
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					access_token: "renewed",
					refresh_token: "rtok-2",
					expires_in: 7200,
					created_at: Math.floor(Date.now() / 1000),
					scope: "api read_user",
					token_type: "bearer",
				}),
			}),
		);

		const { getValidGitLabToken, GitLabReauthRequiredError } = await import(
			"../../lib/gitlab-token"
		);
		const err = await getValidGitLabToken(db as never, {
			userId: "u1",
			organizationId: null,
		}).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(GitLabReauthRequiredError);
		expect((err as Error).message).toMatch(/connection reset by peer/);
		// The token write was ISSUED — so the empty commit below is a rollback,
		// not a path that never wrote anything.
		expect(tx.mCPConfig.update).toHaveBeenCalledTimes(1);
		expect(tx.committedWrites()).toEqual([]);
	});

	it("does NOT condemn when a reconnect replaced the token while the refresh was in flight", async () => {
		// The race the advisory lock cannot close: it serialises refreshers
		// against each other, but the OAuth callback never acquires it. So a
		// user can complete a real reconnect between the read that produced
		// this evidence and the rejection coming back, and an unconditional
		// write would then condemn the credential they just authorized —
		// hard-blocking it, since `needsReauth` is enforced and only another
		// full OAuth flow clears it.
		const stored = liveMcpConfigRow({
			id: "mcp_1",
			encryptedAccessToken: "enc_stale",
			encryptedRefreshToken: "enc_dead",
			needsReauth: false,
		});
		const { db, tx } = dbFor({
			mcpRow: {
				...stored.row,
				tokenExpiresAt: new Date(Date.now() + 10 * 1000),
			},
			mcpConfigStore: stored,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				// The reconnect lands mid-flight: `persistGitLabToken` with a
				// fresh grant rotates both ciphertexts and clears the breaker.
				// It is a separate transaction that has already committed, so
				// it moves both copies of the row.
				stored.externalCommit({
					encryptedAccessToken: "enc_reconnected",
					encryptedRefreshToken: "enc_r2",
					needsReauth: false,
				});
				return {
					ok: false,
					status: 400,
					json: async () => ({ error: "invalid_grant" }),
				};
			}),
		);

		const { getValidGitLabToken, GitLabReauthRequiredError } = await import(
			"../../lib/gitlab-token"
		);
		await expect(
			getValidGitLabToken(db as never, {
				userId: "u1",
				organizationId: null,
			}),
		).rejects.toBeInstanceOf(GitLabReauthRequiredError);

		// The caller still sees the error — only the persisted verdict is
		// withheld, because the row it would have landed on is not the row
		// GitLab passed judgement on.
		expect(stored.committed.needsReauth).toBe(false);
		// The write WAS attempted; the superseded ciphertext is what made it
		// match nothing.
		expect(tx.mCPConfig.updateMany).toHaveBeenCalledWith({
			where: {
				id: "mcp_1",
				encryptedRefreshToken: "enc_dead",
				needsReauth: false,
			},
			data: { needsReauth: true },
		});
	});

	it("binds the no-refresh-token condemnation to the stored access token", async () => {
		// The PRE-READ branch (the in-lock twin is the test below it). It posts
		// nothing, so it has no refresh ciphertext to name. The access-token
		// ciphertext stands in as the row version: a reconnect that supplies
		// the missing refresh token rewrites it too, so it separates "still the
		// row I read" from "already reconnected" just as well.
		const stored = liveMcpConfigRow({
			id: "mcp_1",
			encryptedAccessToken: "enc_stale",
			encryptedRefreshToken: null,
			needsReauth: false,
		});
		const { db, tx } = dbFor({
			mcpRow: {
				...stored.row,
				tokenExpiresAt: new Date(Date.now() + 10 * 1000),
			},
			mcpConfigStore: stored,
		});
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		const { getValidGitLabToken, GitLabReauthRequiredError } = await import(
			"../../lib/gitlab-token"
		);
		await expect(
			getValidGitLabToken(db as never, {
				userId: "u1",
				organizationId: null,
			}),
		).rejects.toBeInstanceOf(GitLabReauthRequiredError);

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(tx.mCPConfig.updateMany).toHaveBeenCalledWith({
			where: {
				id: "mcp_1",
				encryptedAccessToken: "enc_stale",
				needsReauth: false,
			},
			data: { needsReauth: true },
		});
		expect(stored.committed.needsReauth).toBe(true);
	});

	it("persists the in-lock no-refresh-token condemnation past the transaction", async () => {
		// The same branch, reached under the advisory lock: the outer read saw
		// a refresh token, the in-tx re-read no longer does (another writer
		// persisted a grant GitLab issued without one). That branch condemns
		// the row and then fails — and the failure used to be a `throw` from
		// inside the `$transaction` callback, which rolled the condemnation
		// back. The row stayed clean, so the next call walked the same path
		// again and re-condemned nothing, forever.
		const stored = liveMcpConfigRow({
			id: "mcp_1",
			encryptedAccessToken: "enc_stale",
			encryptedRefreshToken: null,
			needsReauth: false,
		});
		const { db, tx } = dbFor({
			// The default answer — what the RE-READ inside the lock sees.
			mcpRow: {
				...stored.row,
				tokenExpiresAt: new Date(Date.now() + 10 * 1000),
			},
			mcpConfigStore: stored,
		});
		// The outer pre-read still holds a refresh token, so it hands off to
		// the locked path instead of condemning on the spot.
		tx.mCPConfig.findFirst.mockResolvedValueOnce({
			id: "mcp_1",
			encryptedAccessToken: "enc_stale",
			encryptedRefreshToken: "enc_rtok",
			tokenExpiresAt: new Date(Date.now() + 10 * 1000),
			needsReauth: false,
		});
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		const { getValidGitLabToken, GitLabReauthRequiredError } = await import(
			"../../lib/gitlab-token"
		);
		await expect(
			getValidGitLabToken(db as never, {
				userId: "u1",
				organizationId: null,
			}),
		).rejects.toBeInstanceOf(GitLabReauthRequiredError);

		// Nothing was posted to GitLab — this branch never gets that far.
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(tx.mCPConfig.updateMany).toHaveBeenCalledWith({
			where: {
				id: "mcp_1",
				encryptedAccessToken: "enc_stale",
				needsReauth: false,
			},
			data: { needsReauth: true },
		});
		expect(stored.committed.needsReauth).toBe(true);
		expect(tx.committedWrites()).toContain("mCPConfig.updateMany");
	});

	it("declines the no-refresh-token condemnation once the row has been reconnected", async () => {
		// Same branch, stale read: the row already carries a new grant (access
		// token rotated, refresh token supplied) by the time the write goes
		// out. Without the version token this request would condemn a
		// credential that is complete and working.
		const stored = liveMcpConfigRow({
			id: "mcp_1",
			encryptedAccessToken: "enc_reconnected",
			encryptedRefreshToken: "enc_r2",
			needsReauth: false,
		});
		const { db } = dbFor({
			mcpRow: {
				id: "mcp_1",
				encryptedAccessToken: "enc_stale",
				encryptedRefreshToken: null,
				tokenExpiresAt: new Date(Date.now() + 10 * 1000),
				needsReauth: false,
			},
			mcpConfigStore: stored,
		});
		vi.stubGlobal("fetch", vi.fn());

		const { getValidGitLabToken, GitLabReauthRequiredError } = await import(
			"../../lib/gitlab-token"
		);
		await expect(
			getValidGitLabToken(db as never, {
				userId: "u1",
				organizationId: null,
			}),
		).rejects.toBeInstanceOf(GitLabReauthRequiredError);

		expect(stored.committed.needsReauth).toBe(false);
	});

	it("leaves the enforced MCPConfig breaker alone for a legacy WorkflowIntegration credential", async () => {
		// A token read out of the legacy store is no evidence about any
		// MCPConfig row — the two hold separate credentials, and the MCPConfig
		// one was not even loadable here. Skipping that write is not a fail
		// open: for these `loadGitLabToken` reads the breaker out of
		// `settings.needsReauth`, which this call still sets, so the retry
		// loop is stopped on the store the dead credential actually lives in.
		const expiresAtIso = new Date(Date.now() + 10 * 1000).toISOString();
		const { db, tx } = dbFor({
			mcpRow: null,
			wiRow: {
				id: "wi_1",
				credentials: `enc_${JSON.stringify({
					access_token: "wi-access",
					refresh_token: "wi-dead",
				})}`,
				settings: { tokenExpiresAt: expiresAtIso },
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 400,
				json: async () => ({ error: "invalid_grant" }),
			}),
		);

		const { getValidGitLabToken, GitLabReauthRequiredError } = await import(
			"../../lib/gitlab-token"
		);
		await expect(
			getValidGitLabToken(db as never, {
				userId: "u1",
				organizationId: null,
			}),
		).rejects.toBeInstanceOf(GitLabReauthRequiredError);

		expect(tx.mCPConfig.updateMany).not.toHaveBeenCalled();
		const updateCall = tx.workflowIntegration.update.mock.calls[0][0] as {
			data: { settings: Record<string, unknown> };
		};
		expect(updateCall.data.settings).toMatchObject({ needsReauth: true });
	});

	it("clears cached useOfficialMcp + mcpProbe when refresh fails (no stale capability)", async () => {
		// Regression: integration provider page rendered "Connected via REST"
		// optimistically off WorkflowIntegration.settings.mcpProbe even after
		// the refresh-token had died. markNeedsReauth must clear the cached
		// probe so the next `status` query reflects reality.
		const expired = new Date(Date.now() + 10 * 1000);
		const { db, tx } = dbFor({
			mcpRow: {
				id: "mcp_1",
				encryptedAccessToken: "enc_stale",
				encryptedRefreshToken: "enc_dead",
				tokenExpiresAt: expired,
				needsReauth: false,
			},
			wiRow: {
				id: "wi_1",
				settings: {
					gitlabUsername: "exampleuser",
					useOfficialMcp: false,
					mcpProbe: {
						status: "tier-gated",
						httpStatus: 403,
						checkedAt: "2026-05-27T00:00:00Z",
					},
				},
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 400,
				json: async () => ({ error: "invalid_grant" }),
			}),
		);

		const { getValidGitLabToken, GitLabReauthRequiredError } = await import(
			"../../lib/gitlab-token"
		);
		await expect(
			getValidGitLabToken(db as never, {
				userId: "u1",
				organizationId: null,
			}),
		).rejects.toBeInstanceOf(GitLabReauthRequiredError);

		// WorkflowIntegration.settings is rewritten WITHOUT the stale probe
		// fields, plus needsReauth=true. Identity-preserving fields (e.g.
		// gitlabUsername) survive. Asserted with objectContaining so this
		// doesn't break when a future commit adds an unrelated key — we
		// pin the contract (cleared cache + needsReauth) not the literal
		// settings shape.
		expect(tx.workflowIntegration.update).toHaveBeenCalledTimes(1);
		const updateCall = tx.workflowIntegration.update.mock.calls[0][0] as {
			where: { id: string };
			data: { settings: Record<string, unknown> };
		};
		expect(updateCall.where).toEqual({ id: "wi_1" });
		expect(updateCall.data.settings).toEqual(
			expect.objectContaining({
				gitlabUsername: "exampleuser",
				needsReauth: true,
			}),
		);
		expect(updateCall.data.settings).not.toHaveProperty("useOfficialMcp");
		expect(updateCall.data.settings).not.toHaveProperty("mcpProbe");
	});

	it("handles null/missing settings gracefully (no crash, writes needsReauth only)", async () => {
		// Defensive: the `?? {}` fallback on `wi.settings` is the only thing
		// keeping the destructure safe when a row predates the settings
		// rollout. Without this test a future refactor swapping `??` for
		// `||` (or reordering the destructure) would crash without warning.
		const expired = new Date(Date.now() + 10 * 1000);
		const { db, tx } = dbFor({
			mcpRow: {
				id: "mcp_1",
				encryptedAccessToken: "enc_stale",
				encryptedRefreshToken: "enc_dead",
				tokenExpiresAt: expired,
				needsReauth: false,
			},
			wiRow: { id: "wi_legacy", settings: null },
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 400,
				json: async () => ({ error: "invalid_grant" }),
			}),
		);

		const { getValidGitLabToken, GitLabReauthRequiredError } = await import(
			"../../lib/gitlab-token"
		);
		await expect(
			getValidGitLabToken(db as never, {
				userId: "u1",
				organizationId: null,
			}),
		).rejects.toBeInstanceOf(GitLabReauthRequiredError);

		expect(tx.workflowIntegration.update).toHaveBeenCalledTimes(1);
		const updateCall = tx.workflowIntegration.update.mock.calls[0][0] as {
			where: { id: string };
			data: { settings: Record<string, unknown> };
		};
		expect(updateCall.data.settings).toEqual({ needsReauth: true });
	});

	it("throws immediately when stored needsReauth=true", async () => {
		const { db } = dbFor({
			mcpRow: {
				id: "mcp_1",
				encryptedAccessToken: "enc_a",
				encryptedRefreshToken: "enc_r",
				tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
				needsReauth: true,
			},
		});
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		const { getValidGitLabToken, GitLabReauthRequiredError } = await import(
			"../../lib/gitlab-token"
		);
		await expect(
			getValidGitLabToken(db as never, {
				userId: "u1",
				organizationId: null,
			}),
		).rejects.toBeInstanceOf(GitLabReauthRequiredError);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("throws GitLabReauthRequiredError when no token at all", async () => {
		const { db } = dbFor({});
		const { getValidGitLabToken, GitLabReauthRequiredError } = await import(
			"../../lib/gitlab-token"
		);
		await expect(
			getValidGitLabToken(db as never, {
				userId: "u1",
				organizationId: null,
			}),
		).rejects.toBeInstanceOf(GitLabReauthRequiredError);
	});

	it("locked path refreshes inline on tx when re-read still needs refresh — no nested $transaction", async () => {
		// Both reads (outer and inner) see an expiring token, so the locked
		// branch must proceed with refresh-and-persist INSIDE the tx. The
		// critical guarantee: the inner tx mock has NO `$transaction` method
		// — the SUT must never invoke a nested transaction (Prisma's real
		// TransactionClient does not expose `$transaction`).
		const expiringSoon = new Date(Date.now() + 10 * 1000);
		const outer = dbFor({
			mcpRow: {
				id: "mcp_1",
				encryptedAccessToken: "enc_stale",
				encryptedRefreshToken: "enc_rtok",
				tokenExpiresAt: expiringSoon,
				needsReauth: false,
			},
			wiRow: {
				id: "wi_1",
				credentials: "",
				settings: {
					gitlabUserId: 42,
					gitlabUsername: "alice",
					gitlabName: "Alice",
					gitlabAvatarUrl: null,
				},
			},
		});

		// Inner tx db sees the same expiring token on the re-read. The mock
		// intentionally OMITS `$transaction` and asserts nothing of the sort
		// is called on the inner tx.
		const innerTx = freshTx({
			mcpRow: {
				id: "mcp_1",
				encryptedAccessToken: "enc_stale",
				encryptedRefreshToken: "enc_rtok",
				tokenExpiresAt: expiringSoon,
				needsReauth: false,
			},
			wiRow: {
				id: "wi_1",
				credentials: "",
				settings: {
					gitlabUserId: 42,
					gitlabUsername: "alice",
					gitlabName: "Alice",
					gitlabAvatarUrl: null,
				},
			},
		});

		const queryRawSpy = vi.fn().mockResolvedValue(undefined);
		// Note: NO `$transaction` on tx — the SUT must not try to open a
		// nested transaction. If it does, the call will throw
		// `tx.$transaction is not a function`, failing the test.
		const tx = {
			...innerTx,
			$executeRaw: queryRawSpy,
		};
		const fakePrisma = {
			$queryRaw: vi.fn(),
			$transaction: vi.fn(
				async (cb: (t: typeof tx) => Promise<unknown>) => {
					const result = await cb(tx);
					// Buffered writes are promoted only on a RESOLVED
					// callback, same rule as the `dbFor` double.
					tx.commit();
					return result;
				},
			),
		};

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					access_token: "renewed",
					refresh_token: "rtok-2",
					expires_in: 7200,
					created_at: Math.floor(Date.now() / 1000),
					scope: "api read_user",
					token_type: "bearer",
				}),
			}),
		);

		const { getValidGitLabToken } = await import("../../lib/gitlab-token");
		const token = await getValidGitLabToken(
			outer.db as never,
			{ userId: "u1", organizationId: null },
			{ prisma: fakePrisma as never },
		);

		expect(token).toBe("renewed");
		// Lock was acquired exactly once.
		expect(queryRawSpy).toHaveBeenCalledTimes(1);
		// Refresh fetched against GitLab token endpoint.
		expect(fetch).toHaveBeenCalledTimes(1);
		// Dual-write happened ON THE TX — not via a nested $transaction.
		// (`tx` deliberately has no `$transaction` method; persisting via the
		// non-tx helper would throw before reaching these writes.)
		expect(innerTx.mCPConfig.update).toHaveBeenCalledTimes(1);
		expect(innerTx.workflowIntegration.update).toHaveBeenCalledTimes(1);
		// Belt-and-braces: explicitly assert no `$transaction` was put on
		// the inner tx and never called as such.
		expect(
			(tx as unknown as Record<string, unknown>).$transaction,
		).toBeUndefined();
	});

	it("takes the advisory lock with NO opts.prisma — the way the only production caller invokes it", async () => {
		// The lock used to be gated behind an explicit `opts.prisma`, and
		// `gitlab-recheck.ts` — the sole production caller — passes only
		// (db, ctx). So the lock existed but never executed outside tests,
		// and two replicas could still spend the same single-use rotating
		// refresh token. It now defaults to `db`; this pins that, because a
		// regression here is invisible (everything still passes, just
		// unserialized).
		const expiringSoon = new Date(Date.now() + 10 * 1000);
		const outer = dbFor({
			mcpRow: {
				id: "mcp_1",
				encryptedAccessToken: "enc_stale",
				encryptedRefreshToken: "enc_rtok",
				tokenExpiresAt: expiringSoon,
				needsReauth: false,
			},
		});

		const { getValidGitLabToken } = await import("../../lib/gitlab-token");
		// No third argument at all.
		await getValidGitLabToken(outer.db as never, {
			userId: "u1",
			organizationId: null,
		}).catch(() => {
			// The refresh itself may fail in this double; the lock is the
			// assertion under test and it is taken before any of that.
		});

		expect(outer.db.$transaction).toHaveBeenCalledTimes(1);
		const lockSql = (
			outer.tx.$executeRaw.mock.calls[0][0] as TemplateStringsArray
		).join("");
		expect(lockSql).toMatch(/pg_advisory_xact_lock\(::int, ::int\)/);
		// Keyed on the mcp_config ROW, not on the tenant tuple.
		expect(outer.tx.$executeRaw.mock.calls[0][2]).toBe(
			advisoryObjectKey(mcpConfigLockKey("mcp_1")),
		);
	});

	it("acquires advisory lock and skips refresh when re-read shows fresh token", async () => {
		// Outer read: expiring → triggers the refresh path. Inside the
		// transaction the re-read returns a fresh expiry (another process
		// got there first) so refresh should NOT fire.
		const expiringSoon = new Date(Date.now() + 10 * 1000);
		const stillFresh = new Date(Date.now() + 60 * 60 * 1000);
		const outer = dbFor({
			mcpRow: {
				id: "mcp_1",
				encryptedAccessToken: "enc_stale",
				encryptedRefreshToken: "enc_rtok",
				tokenExpiresAt: expiringSoon,
				needsReauth: false,
			},
		});

		// Inner tx db sees a fresh token on the re-read.
		const innerTx = freshTx({
			mcpRow: {
				id: "mcp_1",
				encryptedAccessToken: "enc_fresh",
				encryptedRefreshToken: "enc_rtok",
				tokenExpiresAt: stillFresh,
				needsReauth: false,
			},
		});

		const queryRawSpy = vi.fn().mockResolvedValue(undefined);
		const tx = {
			...innerTx,
			$executeRaw: queryRawSpy,
		};
		const fakePrisma = {
			$queryRaw: vi.fn(),
			$transaction: vi.fn(
				async (cb: (t: typeof tx) => Promise<unknown>) => {
					const result = await cb(tx);
					// Buffered writes are promoted only on a RESOLVED
					// callback, same rule as the `dbFor` double.
					tx.commit();
					return result;
				},
			),
		};

		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		const { getValidGitLabToken } = await import("../../lib/gitlab-token");
		const token = await getValidGitLabToken(
			outer.db as never,
			{ userId: "u1", organizationId: null },
			{ prisma: fakePrisma as never },
		);

		expect(token).toBe("fresh");
		// Lock query fired with the SHARED two-int (class, object) shape. It used
		// to use hashtext(...)::bigint — a different Postgres lock space, so it
		// could never serialize against the other GitLab refresh paths touching
		// the same row.
		expect(queryRawSpy).toHaveBeenCalledTimes(1);
		const firstArg = queryRawSpy.mock.calls[0][0] as TemplateStringsArray;
		expect(firstArg.join("")).toMatch(/pg_advisory_xact_lock/);
		expect(firstArg.join("")).toMatch(
			/pg_advisory_xact_lock\(::int, ::int\)/,
		);
		expect(firstArg.join("")).not.toMatch(/hashtext/);
		// Lock is addressed by ROW identity, not by the user tuple. This path and
		// the GitLab tool executor can both refresh the same row; while this one
		// keyed on `gitlab-token:<org>:<user>` it hashed to a different lock id,
		// so neither waited for the other and both spent the same single-use
		// rotating refresh token.
		const [classArg, objectArg] = queryRawSpy.mock.calls[0].slice(1) as [
			number,
			number,
		];
		expect(classArg).toBe(REFRESH_ADVISORY_CLASS);
		expect(objectArg).toBe(advisoryObjectKey(mcpConfigLockKey("mcp_1")));
		// GitLab token endpoint was NOT called — the second reader observed
		// the fresh row and short-circuited.
		expect(fetchSpy).not.toHaveBeenCalled();
		// And no persist happened inside the tx.
		expect(innerTx.mCPConfig.update).not.toHaveBeenCalled();
		expect(innerTx.workflowIntegration.update).not.toHaveBeenCalled();
	});
});

describe("persistGitLabToken", () => {
	beforeEach(() => {
		vi.resetModules();
		// Default probe mock: not capable (safe default for existing tests that
		// don't care about probe behavior — just verifies no network calls are made).
		probeGitLabMcpMock.mockResolvedValue({
			capable: false,
			status: "not-found",
			httpStatus: 404,
		});
	});

	function makeTx(opts?: {
		existingMcp?: unknown;
		existingWi?: unknown;
		gitlabServerId?: string;
	}) {
		const tx = {
			mCPServer: {
				findFirst: vi.fn().mockResolvedValue({
					id: opts?.gitlabServerId ?? "mcp_server_gitlab",
				}),
			},
			mCPConfig: {
				findFirst: vi.fn().mockResolvedValue(opts?.existingMcp ?? null),
				create: vi.fn().mockResolvedValue({}),
				update: vi.fn().mockResolvedValue({}),
				delete: vi.fn().mockResolvedValue({}),
			},
			workflowIntegration: {
				findFirst: vi.fn().mockResolvedValue(opts?.existingWi ?? null),
				create: vi.fn().mockResolvedValue({}),
				update: vi.fn().mockResolvedValue({}),
			},
		};
		return tx;
	}

	function makeDbWithTx(tx: ReturnType<typeof makeTx>) {
		return {
			$transaction: vi.fn(
				async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
			),
		};
	}

	const sampleInput = {
		userId: "u1",
		organizationId: null as string | null,
		token: {
			accessToken: "fresh",
			refreshToken: "rtok",
			expiresAt: new Date("2030-01-01T00:00:00.000Z"),
			scopes: ["api", "read_user"],
		},
		gitlabUser: {
			id: 42,
			username: "alice",
			name: "Alice",
			avatarUrl: null,
		},
		// The OAuth-callback shape: this caller holds a grant the user just
		// authorized, so it carries the breaker-reset authority.
		freshGrant: true,
	};

	it("creates both rows when neither exists", async () => {
		const tx = makeTx();
		const db = makeDbWithTx(tx);
		const { persistGitLabToken } = await import("../../lib/gitlab-token");

		await persistGitLabToken(db as never, sampleInput);

		expect(tx.mCPConfig.create).toHaveBeenCalledTimes(1);
		expect(tx.mCPConfig.update).not.toHaveBeenCalled();
		expect(tx.workflowIntegration.create).toHaveBeenCalledTimes(1);
		expect(tx.workflowIntegration.update).not.toHaveBeenCalled();
		expect(db.$transaction).toHaveBeenCalledTimes(1);
	});

	it("updates both rows when both exist (a fresh grant clears needsReauth)", async () => {
		const tx = makeTx({
			existingMcp: { id: "mcp_1" },
			existingWi: { id: "wi_1", settings: { needsReauth: true } },
		});
		const db = makeDbWithTx(tx);
		const { persistGitLabToken } = await import("../../lib/gitlab-token");

		await persistGitLabToken(db as never, sampleInput);

		expect(tx.mCPConfig.update).toHaveBeenCalledTimes(1);
		expect(tx.mCPConfig.create).not.toHaveBeenCalled();
		const mcpUpdate = tx.mCPConfig.update.mock.calls[0][0] as {
			data: Record<string, unknown>;
		};
		expect(mcpUpdate.data).toMatchObject({
			needsReauth: false,
			status: "HEALTHY",
			refreshFailureCount: 0,
			lastRefreshFailedAt: null,
			lastRefreshError: null,
			consecutiveFailures: 0,
		});

		expect(tx.workflowIntegration.update).toHaveBeenCalledTimes(1);
		const wiUpdate = tx.workflowIntegration.update.mock.calls[0][0] as {
			data: { settings: Record<string, unknown> };
		};
		expect(wiUpdate.data.settings.needsReauth).toBe(false);
	});

	it("leaves every breaker column untouched when the caller has no fresh grant", async () => {
		// The reconcile / renewal shape. `needsReauth` is enforced and only a
		// new grant may lift it, so a caller re-persisting a token it read out
		// of the database must write the token fields and nothing else —
		// otherwise a condemned config comes back to life with the same dead
		// refresh token behind it and restarts the failure cycle.
		const tx = makeTx({
			existingMcp: { id: "mcp_1" },
			existingWi: { id: "wi_1", settings: { needsReauth: true } },
		});
		const db = makeDbWithTx(tx);
		const { persistGitLabToken } = await import("../../lib/gitlab-token");

		await persistGitLabToken(db as never, {
			...sampleInput,
			freshGrant: false,
		});

		const mcpUpdate = tx.mCPConfig.update.mock.calls[0][0] as {
			data: Record<string, unknown>;
		};
		expect(mcpUpdate.data).toEqual({
			encryptedAccessToken: "enc_fresh",
			accessTokenHash: "hash_fresh",
			encryptedRefreshToken: "enc_rtok",
			tokenExpiresAt: sampleInput.token.expiresAt,
		});
		for (const column of [
			"needsReauth",
			"status",
			"refreshFailureCount",
			"lastRefreshFailedAt",
			"lastRefreshError",
			"consecutiveFailures",
		]) {
			expect(column in mcpUpdate.data).toBe(false);
		}

		// The WorkflowIntegration settings blob mirrors the same flag, and the
		// blob is rebuilt from scratch on every write — so it has to carry the
		// stored value forward rather than default it to false.
		const wiUpdate = tx.workflowIntegration.update.mock.calls[0][0] as {
			data: { settings: Record<string, unknown> };
		};
		expect(wiUpdate.data.settings.needsReauth).toBe(true);
	});

	it("encrypts the access token and computes its hash for MCPConfig", async () => {
		const tx = makeTx();
		const db = makeDbWithTx(tx);
		const { persistGitLabToken } = await import("../../lib/gitlab-token");

		await persistGitLabToken(db as never, sampleInput);

		const create = tx.mCPConfig.create.mock.calls[0][0] as {
			data: {
				encryptedAccessToken: string;
				accessTokenHash: string;
				encryptedRefreshToken: string | null;
			};
		};
		expect(create.data.encryptedAccessToken).toBe("enc_fresh");
		expect(create.data.accessTokenHash).toBe("hash_fresh");
		expect(create.data.encryptedRefreshToken).toBe("enc_rtok");
	});

	it("throws when the GitLab MCPServer row is missing", async () => {
		const tx = makeTx();
		tx.mCPServer.findFirst.mockResolvedValue(null);
		const db = makeDbWithTx(tx);
		const { persistGitLabToken } = await import("../../lib/gitlab-token");

		await expect(
			persistGitLabToken(db as never, sampleInput),
		).rejects.toThrow(/GitLab MCPServer/);
	});

	it("respects organization context (XOR) on both lookups", async () => {
		const tx = makeTx();
		const db = makeDbWithTx(tx);
		const { persistGitLabToken } = await import("../../lib/gitlab-token");

		await persistGitLabToken(db as never, {
			...sampleInput,
			organizationId: "org_1",
		});

		expect(tx.mCPConfig.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					userId: "u1",
					organizationId: "org_1",
					mcpServerId: "mcp_server_gitlab",
				}),
			}),
		);
		expect(tx.workflowIntegration.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					userId: "u1",
					organizationId: "org_1",
					provider: "GITLAB",
				}),
			}),
		);
	});
});

describe("loadGitLabToken", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("returns the MCPConfig token when present (primary store)", async () => {
		const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
		const fakeDb = {
			mCPConfig: {
				findFirst: vi.fn().mockResolvedValue({
					id: "mcp_1",
					encryptedAccessToken: "enc_mcp-access",
					encryptedRefreshToken: "enc_mcp-refresh",
					tokenExpiresAt: expiresAt,
					needsReauth: false,
				}),
			},
			workflowIntegration: { findFirst: vi.fn() },
		};

		const { loadGitLabToken } = await import("../../lib/gitlab-token");
		const token = await loadGitLabToken(fakeDb as never, {
			userId: "u1",
			organizationId: null,
		});

		expect(token).toEqual({
			source: "mcp",
			// Row identity is now returned so the refresh path can derive the same
			// advisory-lock key every other path uses for this row.
			rowId: "mcp_1",
			accessToken: "mcp-access",
			refreshToken: "mcp-refresh",
			// The stored ciphertexts ride along with the decrypted values. A
			// condemnation has to bind itself to the row version it judged,
			// and `encryptApiKey` is non-deterministic — re-encrypting the
			// plaintext above would match nothing, so the only way to hold
			// that version token is to carry it out of this read.
			encryptedAccessToken: "enc_mcp-access",
			encryptedRefreshToken: "enc_mcp-refresh",
			expiresAt,
			needsReauth: false,
		});
		expect(fakeDb.workflowIntegration.findFirst).not.toHaveBeenCalled();
	});

	it("falls back to WorkflowIntegration when MCPConfig is missing", async () => {
		const expiresAtIso = new Date(Date.now() + 5 * 60 * 1000).toISOString();
		const fakeDb = {
			mCPConfig: { findFirst: vi.fn().mockResolvedValue(null) },
			workflowIntegration: {
				findFirst: vi.fn().mockResolvedValue({
					id: "wi_1",
					credentials:
						"enc_" +
						JSON.stringify({
							access_token: "wi-access",
							refresh_token: "wi-refresh",
						}),
					settings: {
						tokenExpiresAt: expiresAtIso,
					},
				}),
			},
		};

		const { loadGitLabToken } = await import("../../lib/gitlab-token");
		const token = await loadGitLabToken(fakeDb as never, {
			userId: "u1",
			organizationId: null,
		});

		expect(token?.source).toBe("workflow_integration");
		expect(token?.accessToken).toBe("wi-access");
		expect(token?.refreshToken).toBe("wi-refresh");
		expect(token?.expiresAt?.toISOString()).toBe(expiresAtIso);
		expect(token?.needsReauth).toBe(false);
		// No MCPConfig ciphertexts: this store keeps one encrypted JSON blob
		// covering both tokens, so a rejection about it is no evidence about
		// any MCPConfig row and must not be able to condemn one.
		expect(token?.encryptedAccessToken).toBeUndefined();
		expect(token?.encryptedRefreshToken).toBeUndefined();
	});

	it("reads needsReauth from WorkflowIntegration settings", async () => {
		const fakeDb = {
			mCPConfig: { findFirst: vi.fn().mockResolvedValue(null) },
			workflowIntegration: {
				findFirst: vi.fn().mockResolvedValue({
					id: "wi_1",
					credentials: `enc_${JSON.stringify({ access_token: "a" })}`,
					settings: { needsReauth: true },
				}),
			},
		};
		const { loadGitLabToken } = await import("../../lib/gitlab-token");
		const token = await loadGitLabToken(fakeDb as never, {
			userId: "u1",
			organizationId: null,
		});
		expect(token?.needsReauth).toBe(true);
	});

	it("returns null when neither row exists", async () => {
		const fakeDb = {
			mCPConfig: { findFirst: vi.fn().mockResolvedValue(null) },
			workflowIntegration: {
				findFirst: vi.fn().mockResolvedValue(null),
			},
		};
		const { loadGitLabToken } = await import("../../lib/gitlab-token");
		const token = await loadGitLabToken(fakeDb as never, {
			userId: "u1",
			organizationId: null,
		});
		expect(token).toBeNull();
	});

	it("respects organization context (XOR)", async () => {
		const fakeDb = {
			mCPConfig: { findFirst: vi.fn().mockResolvedValue(null) },
			workflowIntegration: {
				findFirst: vi.fn().mockResolvedValue(null),
			},
		};
		const { loadGitLabToken } = await import("../../lib/gitlab-token");
		await loadGitLabToken(fakeDb as never, {
			userId: "u1",
			organizationId: "org_1",
		});
		expect(fakeDb.mCPConfig.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					userId: "u1",
					organizationId: "org_1",
					mcpServer: { key: "gitlab" },
				}),
			}),
		);
		expect(fakeDb.workflowIntegration.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					userId: "u1",
					organizationId: "org_1",
					provider: "GITLAB",
				}),
			}),
		);
	});
});

// ---------------------------------------------------------------------------
// buildTxMock helper for probe wiring tests
// ---------------------------------------------------------------------------

function buildTxMock(opts: {
	gitlabOfficialServer: { id: string } | null;
	gitlabLegacyServer: { id: string } | null;
	existingOfficialMcpConfig: { id: string; needsReauth?: boolean } | null;
}) {
	let lastSettings: unknown = null;
	let officialCreates = 0;
	const deletedIds: string[] = [];
	let officialDeletes = 0;

	const tx = {
		mCPServer: {
			findFirst: vi.fn(async (args: { where?: { key?: string } }) => {
				const key = args?.where?.key;
				if (key === "gitlab-official") {
					return opts.gitlabOfficialServer;
				}
				if (key === "gitlab") {
					return opts.gitlabLegacyServer;
				}
				return null;
			}),
		},
		mCPConfig: {
			findFirst: vi.fn(
				async (args: { where?: { mcpServerId?: string } }) => {
					const serverId = args?.where?.mcpServerId;
					if (
						serverId === opts.gitlabOfficialServer?.id &&
						opts.existingOfficialMcpConfig
					) {
						// `needsReauth` is part of the row's select, so default
						// it the way an untripped row reads.
						return {
							needsReauth: false,
							...opts.existingOfficialMcpConfig,
						};
					}
					return null;
				},
			),
			create: vi.fn(async (args: { data?: { mcpServerId?: string } }) => {
				if (args?.data?.mcpServerId === opts.gitlabOfficialServer?.id) {
					officialCreates++;
				}
				return { id: `created-${Math.random()}` };
			}),
			update: vi.fn(async () => ({ id: "updated" })),
			delete: vi.fn(async (args: { where?: { id?: string } }) => {
				const id = args?.where?.id;
				if (id) {
					deletedIds.push(id);
					if (id === opts.existingOfficialMcpConfig?.id) {
						officialDeletes++;
					}
				}
			}),
		},
		workflowIntegration: {
			findFirst: vi.fn(async () => null),
			create: vi.fn(async (args: { data?: { settings?: unknown } }) => {
				lastSettings = args.data?.settings;
				return { id: "wi-1" };
			}),
			update: vi.fn(async (args: { data?: { settings?: unknown } }) => {
				lastSettings = args.data?.settings;
				return { id: "wi-updated" };
			}),
		},
	};

	return {
		$transaction: async <T>(cb: (t: typeof tx) => Promise<T>) => cb(tx),
		...tx,
		workflowIntegration: {
			...tx.workflowIntegration,
			lastWrittenSettings: () => lastSettings,
		},
		mCPConfig: {
			...tx.mCPConfig,
			createsForServer: (id: string) =>
				id === opts.gitlabOfficialServer?.id ? officialCreates : 0,
			deletesForServer: (id: string) =>
				id === opts.gitlabOfficialServer?.id ? officialDeletes : 0,
			deletedIds: () => deletedIds,
		},
	} as any;
}

describe("persistGitLabToken — probe wiring", () => {
	const baseInput = {
		userId: "u1",
		organizationId: null as string | null,
		token: {
			accessToken: "at",
			refreshToken: "rt",
			expiresAt: new Date(Date.now() + 60 * 60_000),
			scopes: ["api"],
		},
		gitlabUser: {
			id: 42,
			username: "alice",
			name: "Alice",
			avatarUrl: null,
		},
		freshGrant: true,
	};

	beforeEach(() => {
		vi.resetModules();
	});

	it("writes useOfficialMcp=true and creates gitlab-official MCPConfig when probe succeeds", async () => {
		probeGitLabMcpMock.mockResolvedValue({
			capable: true,
			status: "ok",
			httpStatus: 200,
		});

		const db = buildTxMock({
			gitlabOfficialServer: { id: "srv-official" },
			gitlabLegacyServer: { id: "srv-legacy" },
			existingOfficialMcpConfig: null,
		});

		const { persistGitLabToken } = await import("../../lib/gitlab-token");
		await persistGitLabToken(db as never, baseInput);

		const wiSettings =
			db.workflowIntegration.lastWrittenSettings() as Record<
				string,
				unknown
			>;
		expect(wiSettings.useOfficialMcp).toBe(true);
		expect(wiSettings.mcpProbe).toMatchObject({
			status: "ok",
			httpStatus: 200,
			baseUrl: "https://gitlab.com",
		});
		expect(db.mCPConfig.createsForServer("srv-official")).toBe(1);
		expect(db.mCPConfig.deletesForServer("srv-official")).toBe(0);
	});

	it("OMITS useOfficialMcp and skips sync on non-authoritative probe (network-error)", async () => {
		probeGitLabMcpMock.mockResolvedValue({
			capable: false,
			status: "network-error",
			httpStatus: null,
		});

		const db = buildTxMock({
			gitlabOfficialServer: { id: "srv-official" },
			gitlabLegacyServer: { id: "srv-legacy" },
			existingOfficialMcpConfig: { id: "preexisting-cfg" },
		});

		const { persistGitLabToken } = await import("../../lib/gitlab-token");
		await persistGitLabToken(db as never, baseInput);

		const wiSettings =
			db.workflowIntegration.lastWrittenSettings() as Record<
				string,
				unknown
			>;
		// Flag is OMITTED so resolver falls through to legacy
		// MCPConfig-presence-wins behavior (doesn't downgrade premium users).
		expect("useOfficialMcp" in wiSettings).toBe(false);
		// Probe record IS written for audit/telemetry visibility.
		expect(wiSettings.mcpProbe).toMatchObject({ status: "network-error" });
		// Sync skipped — the prior MCPConfig is NOT deleted on a transient blip.
		expect(db.mCPConfig.deletesForServer("srv-official")).toBe(0);
		expect(db.mCPConfig.createsForServer("srv-official")).toBe(0);
	});

	it("resets the whole circuit-breaker state on the gitlab-official MCPConfig (fresh grant)", async () => {
		// The mirror of the recheck guard: persistGitLabToken DOES hold a
		// fresh OAuth grant, so it is the one caller allowed to lift
		// `needsReauth` and clear the failure counters. Leaving
		// refreshFailureCount at its tripped value would re-trip the breaker
		// on the next single transient failure.
		probeGitLabMcpMock.mockResolvedValue({
			capable: true,
			status: "ok",
			httpStatus: 200,
		});

		const db = buildTxMock({
			gitlabOfficialServer: { id: "srv-official" },
			gitlabLegacyServer: { id: "srv-legacy" },
			existingOfficialMcpConfig: { id: "preexisting-cfg" },
		});

		const { persistGitLabToken } = await import("../../lib/gitlab-token");
		await persistGitLabToken(db as never, baseInput);

		// Only the gitlab-official sync updates an MCPConfig here — the legacy
		// row doesn't exist in this fixture, so it takes the create branch.
		expect(db.mCPConfig.update).toHaveBeenCalledTimes(1);
		const updateCall = db.mCPConfig.update.mock.calls[0][0] as {
			where: { id: string };
			data: Record<string, unknown>;
		};
		expect(updateCall.where).toEqual({ id: "preexisting-cfg" });
		expect(updateCall.data).toMatchObject({
			needsReauth: false,
			status: "HEALTHY",
			refreshFailureCount: 0,
			lastRefreshFailedAt: null,
			lastRefreshError: null,
			consecutiveFailures: 0,
		});
	});

	it("leaves the gitlab-official circuit-breaker state alone without a fresh grant", async () => {
		// The other half of the same authority. This row carries its OWN
		// refresh token and is condemned independently (by the PM adapter and
		// the Temporal resolver), so a caller that only re-persisted or renewed
		// the PRIMARY credential holds no evidence about it whatsoever.
		probeGitLabMcpMock.mockResolvedValue({
			capable: true,
			status: "ok",
			httpStatus: 200,
		});

		const db = buildTxMock({
			gitlabOfficialServer: { id: "srv-official" },
			gitlabLegacyServer: { id: "srv-legacy" },
			existingOfficialMcpConfig: { id: "preexisting-cfg" },
		});

		const { persistGitLabToken } = await import("../../lib/gitlab-token");
		await persistGitLabToken(db as never, {
			...baseInput,
			freshGrant: false,
		});

		expect(db.mCPConfig.update).toHaveBeenCalledTimes(1);
		const updateCall = db.mCPConfig.update.mock.calls[0][0] as {
			where: { id: string };
			data: Record<string, unknown>;
		};
		expect(updateCall.where).toEqual({ id: "preexisting-cfg" });
		// The token bundle is still refreshed on the row — only the breaker
		// columns are withheld.
		expect(updateCall.data).toMatchObject({
			encryptedAccessToken: "enc_at",
			accessTokenHash: "hash_at",
			encryptedRefreshToken: "enc_rt",
		});
		for (const column of [
			"needsReauth",
			"status",
			"refreshFailureCount",
			"lastRefreshFailedAt",
			"lastRefreshError",
			"consecutiveFailures",
		]) {
			expect(column in updateCall.data).toBe(false);
		}
	});

	it("recovers a condemned gitlab-official row on a fresh grant even when the probe is NOT authoritative", async () => {
		// Probe authority is about CAPABILITY; a completed authorization-code
		// exchange is conclusive about the CREDENTIAL. Fusing them stranded
		// users whose reconnect happened to race a probe timeout: the official
		// row kept its breaker and its dead token, `reconcile` refuses while
		// either row is condemned, and the capability recheck has no authority
		// to clear it — so nothing short of another OAuth flow, landing on a
		// working probe, could recover it.
		probeGitLabMcpMock.mockResolvedValue({
			capable: false,
			status: "network-error",
			httpStatus: null,
		});

		const db = buildTxMock({
			gitlabOfficialServer: { id: "srv-official" },
			gitlabLegacyServer: { id: "srv-legacy" },
			existingOfficialMcpConfig: {
				id: "condemned-cfg",
				needsReauth: true,
			},
		});

		const { persistGitLabToken } = await import("../../lib/gitlab-token");
		await persistGitLabToken(db as never, baseInput);

		// The legacy row doesn't exist in this fixture (create branch), so the
		// single update is the official row's breaker reset.
		expect(db.mCPConfig.update).toHaveBeenCalledTimes(1);
		const updateCall = db.mCPConfig.update.mock.calls[0][0] as {
			where: { id: string };
			data: Record<string, unknown>;
		};
		expect(updateCall.where).toEqual({ id: "condemned-cfg" });
		expect(updateCall.data).toMatchObject({
			encryptedAccessToken: "enc_at",
			accessTokenHash: "hash_at",
			encryptedRefreshToken: "enc_rt",
			needsReauth: false,
			status: "HEALTHY",
			refreshFailureCount: 0,
			lastRefreshFailedAt: null,
			lastRefreshError: null,
			consecutiveFailures: 0,
		});
		// Credential-only: an inconclusive probe still makes no capability
		// decision, so the flag stays absent and the row is neither created
		// nor deleted.
		const wiSettings =
			db.workflowIntegration.lastWrittenSettings() as Record<
				string,
				unknown
			>;
		expect("useOfficialMcp" in wiSettings).toBe(false);
		expect(db.mCPConfig.createsForServer("srv-official")).toBe(0);
		expect(db.mCPConfig.deletesForServer("srv-official")).toBe(0);
	});

	it("leaves the gitlab-official row alone on a non-authoritative probe without a fresh grant", async () => {
		// The reset above is bounded by the same authority as everywhere else:
		// a caller that only re-persisted or renewed the primary credential
		// holds no evidence about this row at all.
		probeGitLabMcpMock.mockResolvedValue({
			capable: false,
			status: "network-error",
			httpStatus: null,
		});

		const db = buildTxMock({
			gitlabOfficialServer: { id: "srv-official" },
			gitlabLegacyServer: { id: "srv-legacy" },
			existingOfficialMcpConfig: {
				id: "condemned-cfg",
				needsReauth: true,
			},
		});

		const { persistGitLabToken } = await import("../../lib/gitlab-token");
		await persistGitLabToken(db as never, {
			...baseInput,
			freshGrant: false,
		});

		expect(db.mCPConfig.update).not.toHaveBeenCalled();
		expect(db.mCPConfig.deletesForServer("srv-official")).toBe(0);
	});

	it("writes useOfficialMcp=false and deletes any stale gitlab-official MCPConfig when probe fails", async () => {
		probeGitLabMcpMock.mockResolvedValue({
			capable: false,
			status: "not-found",
			httpStatus: 404,
		});

		const db = buildTxMock({
			gitlabOfficialServer: { id: "srv-official" },
			gitlabLegacyServer: { id: "srv-legacy" },
			existingOfficialMcpConfig: { id: "stale-cfg" },
		});

		const { persistGitLabToken } = await import("../../lib/gitlab-token");
		await persistGitLabToken(db as never, baseInput);

		const wiSettings =
			db.workflowIntegration.lastWrittenSettings() as Record<
				string,
				unknown
			>;
		expect(wiSettings.useOfficialMcp).toBe(false);
		expect(wiSettings.mcpProbe).toMatchObject({
			status: "not-found",
			httpStatus: 404,
		});
		expect(db.mCPConfig.createsForServer("srv-official")).toBe(0);
		expect(db.mCPConfig.deletedIds()).toContain("stale-cfg");
	});
});
