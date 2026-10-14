/**
 * Writes a chat turn makes as a side effect of reading or of preparing a
 * tool call check the ambient dispatch guard (`@repo/utils/dispatch-guard`)
 * synchronously immediately before they are issued, inside the query helper:
 *
 * - the registered-agent metadata merge under the agent-card cache refresh
 *   (after the card GET) and the agent embedding cache (after the embedding);
 * - the search-provider usage counters (after the web search);
 * - the authority request a write tool raises when the run lacks authority
 *   (after the authority reads).
 *
 * Each caller reaches the helper after awaits of its own, so a stop that
 * lands during them must be caught by the helper. The guard here has
 * already latched its stop, or latches it during the helper's own read.
 * The Prisma client is faked: these pin which writes are issued.
 */

import { runWithDispatchGuard } from "@repo/utils/dispatch-guard";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	stopped: false,
	/** Runs inside the named read; the test latches the stop there. */
	during: {} as Record<string, (() => void) | undefined>,
	executeRaw: vi.fn(),
	orgSearchProviderUpdate: vi.fn(),
	userSearchProviderUpsert: vi.fn(),
	grantFindMany: vi.fn(),
	grantCreate: vi.fn(),
	sessionFindFirst: vi.fn(),
	transaction: vi.fn(),
}));

async function reading<T>(name: string, value: T): Promise<T> {
	await Promise.resolve();
	h.during[name]?.();
	return value;
}

vi.mock("../prisma/client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../prisma/client")>();
	return {
		...actual,
		db: {
			$executeRaw: h.executeRaw,
			$transaction: h.transaction,
			organizationSearchProvider: { update: h.orgSearchProviderUpdate },
			userSearchProvider: { upsert: h.userSearchProviderUpsert },
			authorityGrant: {
				findMany: h.grantFindMany,
				create: h.grantCreate,
			},
			authoritySession: { findFirst: h.sessionFindFirst },
		},
	};
});

const { updateAgentCardCache, updateAgentEmbedding } = await import(
	"../prisma/queries/registered-agents"
);
const {
	incrementOrganizationSearchProviderUsage,
	incrementUserSearchProviderUsage,
} = await import("../prisma/queries/search-providers");
const { ensureSensitiveOperationAuthority } = await import(
	"../prisma/queries/authority"
);

const STOP = new Error("the chat turn stopped");

const guard = {
	key: "turn-example-1",
	assertDispatchable: async () => undefined,
	abortSignal: () => undefined,
	rethrowIfStopped: (error: unknown) => {
		if (error === STOP) {
			throw error;
		}
	},
	throwIfStopped: () => {
		if (h.stopped) {
			throw STOP;
		}
	},
};

const inTurn = <T>(work: () => Promise<T>) =>
	runWithDispatchGuard(guard, work).then(
		(value) => ({ resolvedWith: value }),
		(error: unknown) => error,
	);

beforeEach(() => {
	h.stopped = false;
	h.during = {};
	h.executeRaw.mockReset().mockResolvedValue(1);
	h.orgSearchProviderUpdate.mockReset().mockResolvedValue({});
	h.userSearchProviderUpsert.mockReset().mockResolvedValue({});
	h.grantFindMany.mockReset().mockImplementation(() => reading("grants", []));
	h.grantCreate.mockReset().mockResolvedValue({ id: "grant-example-1" });
	h.sessionFindFirst
		.mockReset()
		.mockImplementation(() => reading("pending session", null));
	h.transaction.mockReset().mockResolvedValue({
		session: { id: "session-example-1" },
		grants: [],
	});
});

describe("the registered-agent metadata merge inside a chat turn", () => {
	it("merges when nothing stops the turn", async () => {
		await inTurn(() =>
			updateAgentCardCache(
				"agent-example-1",
				{ name: "Example" },
				new Date(),
			),
		);
		expect(h.executeRaw).toHaveBeenCalledTimes(1);
	});

	it.each([
		[
			"agent-card cache",
			() =>
				updateAgentCardCache(
					"agent-example-1",
					{ name: "Example" },
					new Date(),
				),
		],
		[
			"agent embedding cache",
			() =>
				updateAgentEmbedding("agent-example-1", [0.1, 0.2], new Date()),
		],
	])(
		"issues no UPDATE for the %s once the turn has stopped",
		async (_name, write) => {
			h.stopped = true;
			expect(await inTurn(write)).toBe(STOP);
			expect(h.executeRaw).not.toHaveBeenCalled();
		},
	);

	it("merges as before outside any chat turn", async () => {
		h.stopped = true; // no guard is active, so nothing consults this
		await updateAgentCardCache(
			"agent-example-1",
			{ name: "Example" },
			new Date(),
		);
		expect(h.executeRaw).toHaveBeenCalledTimes(1);
	});
});

describe("the search-provider usage counters inside a chat turn", () => {
	it("count when nothing stops the turn", async () => {
		await inTurn(() =>
			incrementUserSearchProviderUsage({
				userId: "user-example-1",
				providerName: "example-search",
				cost: 0,
			}),
		);
		expect(h.userSearchProviderUpsert).toHaveBeenCalledTimes(1);
	});

	it("write nothing once the turn has stopped", async () => {
		h.stopped = true;
		expect(
			await inTurn(() =>
				incrementOrganizationSearchProviderUsage({
					organizationId: "org-example-1",
					providerName: "example-search",
					cost: 0,
				}),
			),
		).toBe(STOP);
		expect(
			await inTurn(() =>
				incrementUserSearchProviderUsage({
					userId: "user-example-1",
					providerName: "example-search",
					cost: 0,
				}),
			),
		).toBe(STOP);
		expect(h.orgSearchProviderUpdate).not.toHaveBeenCalled();
		expect(h.userSearchProviderUpsert).not.toHaveBeenCalled();
	});
});

describe("the authority request a write tool raises inside a chat turn", () => {
	const ensure = () =>
		ensureSensitiveOperationAuthority({
			userId: "user-example-1",
			organizationId: "org-example-1",
			providerKey: "example-server",
			accessLevel: "WRITE",
			providerType: "MCP",
			providerDisplayName: "Example server",
			runType: "ORCHESTRATOR",
			runId: "orch-example-1",
			toolName: "create_issue",
		});

	it("raises a request when nothing stops the turn", async () => {
		expect(await inTurn(ensure)).toMatchObject({
			resolvedWith: { authorized: false, action: "request_authority" },
		});
		expect(h.transaction).toHaveBeenCalledTimes(1);
	});

	it("raises no request when the turn stops while the pending session is read", async () => {
		h.during["pending session"] = () => {
			h.stopped = true;
		};
		expect(await inTurn(ensure)).toBe(STOP);
		expect(h.transaction).not.toHaveBeenCalled();
	});

	it("adds no grant to a pending session when the turn stops while it is read", async () => {
		h.sessionFindFirst.mockImplementation(() =>
			reading("pending session", {
				id: "session-example-1",
				grants: [],
				expiresAt: new Date(Date.now() + 60_000),
			}),
		);
		h.during["pending session"] = () => {
			h.stopped = true;
		};
		expect(await inTurn(ensure)).toBe(STOP);
		expect(h.grantCreate).not.toHaveBeenCalled();
	});

	it("inserts no grant, and rolls back, when the turn stops during the session insert", async () => {
		const txSessionCreate = vi.fn(() => {
			h.stopped = true;
			return reading("session insert", { id: "session-example-1" });
		});
		const txGrantCreate = vi
			.fn()
			.mockResolvedValue({ id: "grant-example-1" });
		// Runs the callback the way Prisma does: its rejection rolls back.
		h.transaction.mockImplementation(
			(callback: (tx: unknown) => Promise<unknown>) =>
				callback({
					authoritySession: { create: txSessionCreate },
					authorityGrant: { create: txGrantCreate },
				}),
		);
		expect(await inTurn(ensure)).toBe(STOP);
		expect(txSessionCreate).toHaveBeenCalledTimes(1);
		expect(txGrantCreate).not.toHaveBeenCalled();
	});
});
