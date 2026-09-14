/**
 * The two server-side resolvers a deleted organization has to be refused by
 * (Fizzy #2462).
 *
 * These are one fix in two halves and neither is safe alone:
 *
 *  - `getActiveOrganization` is what the slug layout resolves through. Left
 *    open, `/app/{slug}` renders a working-looking shell over a workspace where
 *    every read is refused.
 *  - `getOrganizationList` is what `/app` ROUTES on
 *    (`lastActiveOrganizationId ?? activeOrganizationId ?? organizations.at(0)`).
 *    Left open, it hands the deleted organization straight back — which both
 *    drops people into it at sign-in and turns the layout's redirect into an
 *    infinite bounce.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const findMany = vi.fn();
const getFullOrganization = vi.fn();
const listOrganizations = vi.fn();
const getSession = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
	headers: vi.fn(async () => new Headers()),
}));

vi.mock("@repo/auth", () => ({
	auth: {
		api: {
			getFullOrganization: (...args: unknown[]) =>
				getFullOrganization(...args),
			listOrganizations: (...args: unknown[]) =>
				listOrganizations(...args),
			getSession: (...args: unknown[]) => getSession(...args),
			listUserAccounts: vi.fn(),
			listPasskeys: vi.fn(),
		},
	},
}));

vi.mock("@repo/database", () => ({
	db: {
		organization: {
			findUnique: (...args: unknown[]) => findUnique(...args),
			findMany: (...args: unknown[]) => findMany(...args),
		},
		projectMember: { findFirst: vi.fn() },
		member: { findFirst: vi.fn() },
	},
	getInvitationById: vi.fn(),
}));

// `cache()` from React memoises per request; under test each import is fresh
// and the identity wrapper keeps call counts honest.
vi.mock("react", async () => {
	const actual = await vi.importActual<typeof import("react")>("react");
	return { ...actual, cache: <T>(fn: T) => fn };
});

async function load() {
	return await import("../../modules/saas/auth/lib/server");
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
});

describe("getActiveOrganization", () => {
	it("refuses a deleted organization before asking the auth library", async () => {
		findUnique.mockResolvedValue({ deletedAt: new Date("2098-01-01") });
		const { getActiveOrganization } = await load();

		expect(await getActiveOrganization("example-org")).toBeNull();
		// Refused at the front door. Reaching the auth library at all would mean
		// the guest fallback below it is still reachable too.
		expect(getFullOrganization).not.toHaveBeenCalled();
	});

	it("refuses it for a project-scoped GUEST as well", async () => {
		// The guest fallback queries by slug with no liveness predicate of its
		// own, so before this gate a guest could still reach the shell of an
		// organization its own members had been locked out of.
		findUnique.mockResolvedValue({ deletedAt: new Date("2098-01-01") });
		getFullOrganization.mockRejectedValue(new Error("not a member"));
		getSession.mockResolvedValue({ user: { id: "guest-1" } });
		const { getActiveOrganization } = await load();

		expect(await getActiveOrganization("example-org")).toBeNull();
		expect(getSession).not.toHaveBeenCalled();
	});

	it("resolves a live organization normally", async () => {
		findUnique.mockResolvedValue({ deletedAt: null });
		getFullOrganization.mockResolvedValue({
			id: "org-1",
			slug: "example-org",
		});
		const { getActiveOrganization } = await load();

		expect(await getActiveOrganization("example-org")).toEqual({
			id: "org-1",
			slug: "example-org",
		});
	});

	it("treats an unknown slug as not-deleted and lets the normal path answer", async () => {
		findUnique.mockResolvedValue(null);
		getFullOrganization.mockResolvedValue(null);
		getSession.mockResolvedValue(null);
		const { getActiveOrganization } = await load();

		expect(await getActiveOrganization("no-such-org")).toBeNull();
	});
});

describe("getOrganizationList", () => {
	it("drops deleted organizations from the list /app routes on", async () => {
		listOrganizations.mockResolvedValue([
			{ id: "org-live", slug: "live-org" },
			{ id: "org-dead", slug: "dead-org" },
		]);
		findMany.mockResolvedValue([{ id: "org-dead" }]);
		const { getOrganizationList } = await load();

		expect(await getOrganizationList()).toEqual([
			{ id: "org-live", slug: "live-org" },
		]);
	});

	it("returns an empty list when every organization is deleted", async () => {
		// This is the case that makes the layout redirect terminate: with no
		// live organization left, `requireOrganization` falls through to
		// `/new-organization`, which carries the restore banner.
		listOrganizations.mockResolvedValue([{ id: "org-dead", slug: "dead" }]);
		findMany.mockResolvedValue([{ id: "org-dead" }]);
		const { getOrganizationList } = await load();

		expect(await getOrganizationList()).toEqual([]);
	});

	it("skips the liveness query when the viewer has no organizations", async () => {
		listOrganizations.mockResolvedValue([]);
		const { getOrganizationList } = await load();

		expect(await getOrganizationList()).toEqual([]);
		expect(findMany).not.toHaveBeenCalled();
	});

	it("returns the list untouched when nothing is deleted", async () => {
		listOrganizations.mockResolvedValue([{ id: "org-live", slug: "live" }]);
		findMany.mockResolvedValue([]);
		const { getOrganizationList } = await load();

		expect(await getOrganizationList()).toEqual([
			{ id: "org-live", slug: "live" },
		]);
	});
});
