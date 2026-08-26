/**
 * Tests for the server-side route guard on the personal/account-context
 * Publishing Suite deep-link page (`/app/projects/{id}/publishing` —
 * Publishing Suite Phase 1A, Plan 3, Task 4b, spec §7/GAP-3).
 *
 * The page MUST:
 *   - return `notFound()` when `isPublishingSuiteEnabled()` is false, BEFORE
 *     touching session/project data
 *   - redirect to `/auth/login` when there is no session
 *   - return `notFound()` when the project fetch is rejected (unauthorized /
 *     no project access)
 *   - render `PublishingSuiteList` with `organizationId=null` and
 *     `canEdit = project.canPublish` on the happy path
 *
 * The personal route is for personal projects only — it always resolves
 * `organizationId: null` (never omitted/undefined), mirroring the personal
 * `daily-brief` sibling route.
 *
 * Because the page is a React Server Component and we can't render it
 * through @testing-library directly, we exercise the guard by invoking the
 * page function with mocked session / oRPC / navigation imports and
 * asserting on the outcome — mirroring
 * `apps/web/__tests__/app/admin/audit-log-explorer/page-guard.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockGetSession,
	mockRedirect,
	mockNotFound,
	mockIsPublishingSuiteEnabled,
	mockProjectsGet,
} = vi.hoisted(() => ({
	mockGetSession: vi.fn(),
	mockRedirect: vi.fn(),
	mockNotFound: vi.fn(),
	mockIsPublishingSuiteEnabled: vi.fn(),
	mockProjectsGet: vi.fn(),
}));

vi.mock("@saas/auth/lib/server", () => ({
	getSession: () => mockGetSession(),
}));

vi.mock("next/navigation", () => ({
	redirect: (target: string) => {
		mockRedirect(target);
		throw new Error(`__REDIRECT__:${target}`);
	},
	notFound: () => {
		mockNotFound();
		throw new Error("__NOT_FOUND__");
	},
}));

vi.mock("@repo/utils/feature-flag", () => ({
	isPublishingSuiteEnabled: () => mockIsPublishingSuiteEnabled(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			get: (...args: unknown[]) => mockProjectsGet(...args),
		},
	},
}));

vi.mock("@saas/projects/components/publishing-suite", () => ({
	PublishingSuiteList: () => null,
}));

const PROJECT_ID = "proj-1";

beforeEach(() => {
	vi.clearAllMocks();
	// Default the client UI-rollout flag ON so the existing tests exercise the
	// server-flag / session / project logic. C-Med1 adds a dedicated test for
	// the server-on / client-off ("backend live, UI hidden") state below.
	process.env.NEXT_PUBLIC_FABRIC_FEATURE_PUBLISHING_SUITE = "true";
});

afterEach(() => {
	vi.resetModules();
	delete process.env.NEXT_PUBLIC_FABRIC_FEATURE_PUBLISHING_SUITE;
});

async function callPage() {
	const mod = await import(
		"../../../../app/(saas)/app/(account)/projects/[id]/publishing/page"
	);
	return (
		mod.default as (args: {
			params: Promise<{ id: string }>;
		}) => Promise<unknown>
	)({
		params: Promise.resolve({ id: PROJECT_ID }),
	});
}

describe("Personal Publishing Suite page — route guard", () => {
	it("returns notFound() when the feature flag is off, before touching session/project", async () => {
		mockIsPublishingSuiteEnabled.mockReturnValue(false);

		await expect(callPage()).rejects.toThrow(/__NOT_FOUND__/);

		expect(mockNotFound).toHaveBeenCalledTimes(1);
		expect(mockGetSession).not.toHaveBeenCalled();
		expect(mockProjectsGet).not.toHaveBeenCalled();
	});

	it("returns notFound() when the server flag is on but the client UI flag is off (backend-live, UI-hidden), before touching session/project", async () => {
		// C-Med1: the deep-link route must honor the SAME client UI-rollout flag
		// that gates the tab + onboarding, so a guessed /publishing URL can't
		// render the full list while the UI is intentionally hidden.
		mockIsPublishingSuiteEnabled.mockReturnValue(true);
		process.env.NEXT_PUBLIC_FABRIC_FEATURE_PUBLISHING_SUITE = "false";

		await expect(callPage()).rejects.toThrow(/__NOT_FOUND__/);

		expect(mockNotFound).toHaveBeenCalledTimes(1);
		expect(mockGetSession).not.toHaveBeenCalled();
		expect(mockProjectsGet).not.toHaveBeenCalled();
	});

	it("redirects unauthenticated users to /auth/login", async () => {
		mockIsPublishingSuiteEnabled.mockReturnValue(true);
		mockGetSession.mockResolvedValue(null);

		await expect(callPage()).rejects.toThrow(/__REDIRECT__:\/auth\/login/);
		expect(mockRedirect).toHaveBeenCalledWith("/auth/login");
	});

	it("rejects an unauthorized user (no project access) with notFound()", async () => {
		mockIsPublishingSuiteEnabled.mockReturnValue(true);
		mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
		mockProjectsGet.mockRejectedValue(new Error("NOT_FOUND"));

		await expect(callPage()).rejects.toThrow(/__NOT_FOUND__/);
		expect(mockNotFound).toHaveBeenCalledTimes(1);
	});

	it("renders PublishingSuiteList with organizationId=null and canEdit=true on the happy path", async () => {
		mockIsPublishingSuiteEnabled.mockReturnValue(true);
		mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
		mockProjectsGet.mockResolvedValue({ project: { canPublish: true } });

		const result = (await callPage()) as { props: Record<string, unknown> };

		expect(result.props.projectId).toBe(PROJECT_ID);
		expect(result.props.organizationId).toBeNull();
		expect(result.props.canEdit).toBe(true);
		// Personal projects only — organizationId must be explicit null, not
		// omitted/undefined (which would fall back to the session's active
		// organization and leak an org project into the personal route).
		expect(mockProjectsGet).toHaveBeenCalledWith({
			id: PROJECT_ID,
			organizationId: null,
		});
	});

	it("renders PublishingSuiteList with canEdit=false for a caller without publish rights", async () => {
		mockIsPublishingSuiteEnabled.mockReturnValue(true);
		mockGetSession.mockResolvedValue({ user: { id: "viewer-1" } });
		mockProjectsGet.mockResolvedValue({ project: { canPublish: false } });

		const result = (await callPage()) as { props: Record<string, unknown> };
		expect(result.props.canEdit).toBe(false);
	});
});
