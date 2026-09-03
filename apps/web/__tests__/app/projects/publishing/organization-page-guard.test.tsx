/**
 * Tests for the server-side route guard on the organization-context
 * Publishing Suite deep-link page (`/app/{organizationSlug}/projects/{id}/publishing`
 * — Publishing Suite Phase 1A, Plan 3, Task 4b, spec §7/GAP-3).
 *
 * The page MUST:
 *   - redirect to `/auth/login` when there is no session
 *   - return `notFound()` when the active organization can't be resolved
 *   - return `notFound()` when `isFeatureEnabled("PUBLISHING_SUITE",
 *     organization.id)` is false — resolved AFTER the organization, because
 *     it needs the org id, but still before any project access
 *   - return `notFound()` when the project fetch is rejected (unauthorized /
 *     no project access)
 *   - render `PublishingSuiteList` with `canEdit = project.canPublish` on
 *     the happy path
 *
 * That per-organization gate is the ONLY availability gate on this route. A
 * build-time `NEXT_PUBLIC_*` guard used to run above all of it; it was
 * removed when the flag became org-scoped, because a build-time value
 * carries one answer for every organization and would have let a
 * deployment-wide switch refuse an enrolled one. The first test below pins
 * BOTH directions of the surviving gate — off refuses, on renders — so a
 * re-added second gate fails the suite just as loudly as a deleted first one.
 *
 * F2 (must-have, route-level scope only): this route adds NO gating beyond
 * whatever `projects.get` (`getProjectProcedure`) resolves — it never passes
 * `null` for `organizationId` the way the personal route does, so it can't
 * incorrectly force a personal-only project search for an org-context
 * request. The F2 tests below mock `projects.get` to isolate that claim;
 * they do NOT exercise end-to-end access resolution.
 *
 * KNOWN GAP: end-to-end access for an org member with NO `ProjectMember`
 * row is governed by the shared loader `getProjectById`
 * (`packages/database/prisma/queries/projects/projects.ts`), which grants
 * ORG-project access only to the project owner or an accepted
 * `ProjectMember` row — org membership alone does NOT grant project access
 * (see the docstring at projects.ts:95). `get-project.ts` throws
 * `NOT_FOUND` when that loader returns null, before `canPublish` is ever
 * computed — so today, an org member without a `ProjectMember` row is
 * 404'd by production, not granted `canPublish` via an org-role fallback.
 *
 * Because the page is a React Server Component and we can't render it
 * through @testing-library directly, we exercise the guard by invoking the
 * page function with mocked session / org / oRPC / navigation imports and
 * asserting on the outcome — mirroring
 * `apps/web/__tests__/app/admin/audit-log-explorer/page-guard.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockGetSession,
	mockGetActiveOrganization,
	mockRedirect,
	mockNotFound,
	mockIsFeatureEnabled,
	mockProjectsGet,
} = vi.hoisted(() => ({
	mockGetSession: vi.fn(),
	mockGetActiveOrganization: vi.fn(),
	mockRedirect: vi.fn(),
	mockNotFound: vi.fn(),
	mockIsFeatureEnabled: vi.fn(),
	mockProjectsGet: vi.fn(),
}));

vi.mock("@saas/auth/lib/server", () => ({
	getSession: () => mockGetSession(),
	getActiveOrganization: (slug: string) => mockGetActiveOrganization(slug),
}));

vi.mock("next/navigation", () => ({
	redirect: (target: string) => {
		// Mirror Next's redirect semantics: throwing a sentinel so the caller
		// halts. Tests still inspect what was called via mockRedirect.
		mockRedirect(target);
		throw new Error(`__REDIRECT__:${target}`);
	},
	notFound: () => {
		mockNotFound();
		throw new Error("__NOT_FOUND__");
	},
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			get: (...args: unknown[]) => mockProjectsGet(...args),
		},
	},
}));

// Stub the client component so the import doesn't pull the whole React
// tree — the guard test only cares about which props reach it, not its UI.
vi.mock("@saas/projects/components/publishing-suite", () => ({
	PublishingSuiteList: () => null,
}));

const PROJECT_ID = "proj-1";
const ORG_ID = "org-A";
const ORG_SLUG = "acme";

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.resetModules();
});

async function callPage() {
	const mod = await import(
		"../../../../app/(saas)/app/(organizations)/[organizationSlug]/projects/[id]/publishing/page"
	);
	return (
		mod.default as (args: {
			params: Promise<{ id: string; organizationSlug: string }>;
		}) => Promise<unknown>
	)({
		params: Promise.resolve({ id: PROJECT_ID, organizationSlug: ORG_SLUG }),
	});
}

describe("Organization Publishing Suite page — route guard", () => {
	it("the per-organization gate is the only availability gate", async () => {
		// The build-time NEXT_PUBLIC_* guard is gone. Nothing outside
		// `isFeatureEnabled` can keep the route open, and nothing outside it
		// can close the route for an organization that IS enrolled — so this
		// asserts both directions, not just the refusal. The refusal half
		// fails if the gate is ever deleted; the render half fails if a
		// second, non-org-scoped gate is ever re-added above it (that is
		// exactly what the deleted `NEXT_PUBLIC_*` read was, and nothing in
		// this suite stubs an env var any more).
		mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
		mockGetActiveOrganization.mockResolvedValue({ id: ORG_ID });
		mockProjectsGet.mockResolvedValue({ project: { canPublish: true } });

		mockIsFeatureEnabled.mockResolvedValue(false);
		await expect(callPage()).rejects.toThrow(/__NOT_FOUND__/);
		expect(mockNotFound).toHaveBeenCalledTimes(1);
		expect(mockProjectsGet).not.toHaveBeenCalled();

		mockIsFeatureEnabled.mockResolvedValue(true);
		await expect(callPage()).resolves.toBeDefined();
		// Consulted — not merely un-consulted-and-open: a route that stopped
		// calling the gate entirely would pass the render half on its own.
		expect(mockIsFeatureEnabled).toHaveBeenLastCalledWith(
			"PUBLISHING_SUITE",
			ORG_ID,
		);
		expect(mockNotFound).toHaveBeenCalledTimes(1);
	});

	it("returns notFound() when isFeatureEnabled is false for the resolved organization — after the organization is resolved, but still before project access", async () => {
		// The server gate resolves against the organization, so it cannot run
		// before the organization is known: session and org resolution both
		// precede it. It must still run before `orpcClient.projects.get`.
		mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
		mockGetActiveOrganization.mockResolvedValue({ id: ORG_ID });
		mockIsFeatureEnabled.mockResolvedValue(false);

		await expect(callPage()).rejects.toThrow(/__NOT_FOUND__/);

		expect(mockNotFound).toHaveBeenCalledTimes(1);
		expect(mockGetActiveOrganization).toHaveBeenCalledWith(ORG_SLUG);
		expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
			"PUBLISHING_SUITE",
			ORG_ID,
		);
		expect(mockProjectsGet).not.toHaveBeenCalled();
	});

	it("redirects unauthenticated users to /auth/login", async () => {
		mockGetSession.mockResolvedValue(null);

		await expect(callPage()).rejects.toThrow(/__REDIRECT__:\/auth\/login/);
		expect(mockRedirect).toHaveBeenCalledWith("/auth/login");
		expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
	});

	it("returns notFound() when the active organization can't be resolved from the slug", async () => {
		mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
		mockGetActiveOrganization.mockResolvedValue(null);

		await expect(callPage()).rejects.toThrow(/__NOT_FOUND__/);
		expect(mockGetActiveOrganization).toHaveBeenCalledWith(ORG_SLUG);
		expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
	});

	it("rejects an unauthorized user (no project access) with notFound()", async () => {
		mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
		mockGetActiveOrganization.mockResolvedValue({ id: ORG_ID });
		mockIsFeatureEnabled.mockResolvedValue(true);
		mockProjectsGet.mockRejectedValue(new Error("NOT_FOUND"));

		await expect(callPage()).rejects.toThrow(/__NOT_FOUND__/);
		expect(mockNotFound).toHaveBeenCalledTimes(1);
	});

	it("renders PublishingSuiteList with canEdit=true and the resolved org id on the happy path", async () => {
		mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
		mockGetActiveOrganization.mockResolvedValue({ id: ORG_ID });
		mockIsFeatureEnabled.mockResolvedValue(true);
		mockProjectsGet.mockResolvedValue({ project: { canPublish: true } });

		const result = (await callPage()) as { props: Record<string, unknown> };

		expect(result.props.projectId).toBe(PROJECT_ID);
		expect(result.props.organizationId).toBe(ORG_ID);
		expect(result.props.canEdit).toBe(true);
		expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
			"PUBLISHING_SUITE",
			ORG_ID,
		);
		// F2: the RESOLVED org id must be passed — never `null` — or an
		// org-role-only member (no ProjectMember row) would be searched
		// against personal projects only and incorrectly 404'd.
		expect(mockProjectsGet).toHaveBeenCalledWith({
			id: PROJECT_ID,
			organizationId: ORG_ID,
		});
	});

	it("renders PublishingSuiteList with canEdit=false for a caller without publish rights", async () => {
		mockGetSession.mockResolvedValue({ user: { id: "viewer-1" } });
		mockGetActiveOrganization.mockResolvedValue({ id: ORG_ID });
		mockIsFeatureEnabled.mockResolvedValue(true);
		mockProjectsGet.mockResolvedValue({ project: { canPublish: false } });

		const result = (await callPage()) as { props: Record<string, unknown> };
		expect(result.props.canEdit).toBe(false);
	});

	it("F2(a): given the loader resolves the project, the org route renders it without extra gating and passes the resolved org id (never null)", async () => {
		mockGetSession.mockResolvedValue({
			user: { id: "org-admin-no-member-row" },
		});
		mockGetActiveOrganization.mockResolvedValue({ id: ORG_ID });
		mockIsFeatureEnabled.mockResolvedValue(true);
		// This test mocks projects.get to isolate the ROUTE's own logic —
		// it does not simulate or assert anything about how canPublish is
		// actually resolved for a member-less org caller. See the KNOWN GAP
		// note in the file docblock: end-to-end, that caller is 404'd by the
		// shared getProjectById loader today (org membership alone does not
		// grant project access — projects.ts:95).
		mockProjectsGet.mockResolvedValue({ project: { canPublish: true } });

		const result = (await callPage()) as { props: Record<string, unknown> };

		expect(mockNotFound).not.toHaveBeenCalled();
		expect(result.props.canEdit).toBe(true);
		expect(mockProjectsGet).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: ORG_ID }),
		);
	});

	it("F2(b): an invited org-project guest reaches the create UI (canEdit=true)", async () => {
		mockGetSession.mockResolvedValue({ user: { id: "guest-1" } });
		mockGetActiveOrganization.mockResolvedValue({ id: ORG_ID });
		mockIsFeatureEnabled.mockResolvedValue(true);
		// Simulates canPublish resolved via an active ProjectMember row
		// (the guest invite path) rather than an org role.
		mockProjectsGet.mockResolvedValue({ project: { canPublish: true } });

		const result = (await callPage()) as { props: Record<string, unknown> };

		expect(mockNotFound).not.toHaveBeenCalled();
		expect(result.props.canEdit).toBe(true);
	});
});
