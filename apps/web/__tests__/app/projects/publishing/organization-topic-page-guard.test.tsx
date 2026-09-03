/**
 * Tests for the server-side route guard on the organization-context Publishing
 * Suite TOPIC ITEM page
 * (`/app/{organizationSlug}/projects/{id}/publishing/{topicId}`).
 *
 * Why this file exists separately from the list route's guard test: the detail
 * route's own docblock says it must not gate more loosely than its sibling,
 * because a Publishing Suite topic would otherwise be reachable by guessing a
 * URL while the feature is deliberately unavailable to that organization. That
 * claim was covered by nothing. It mattered less while two gates gated the
 * route and one of them was a deployment-wide build-time variable; with the
 * build-time guard retired, `isFeatureEnabled("PUBLISHING_SUITE",
 * organization.id)` is the only thing standing between a guessed URL and the
 * topic, so it gets its own coverage rather than being assumed to mirror the
 * list route.
 *
 * The page MUST:
 *   - redirect to `/auth/login` when there is no session
 *   - return `notFound()` when the active organization can't be resolved
 *   - return `notFound()` when the organization's `PUBLISHING_SUITE` flag
 *     resolves false — and render when it resolves true, with the gate
 *     asserted to have been consulted using the RESOLVED organization id
 *   - return `notFound()` when the project fetch is rejected
 *   - pass `projectId`, `topicId`, the resolved org id and
 *     `canEdit = project.canPublish` through to `TopicItemPage`
 *
 * Same harness as `organization-page-guard.test.tsx`: the page is a React
 * Server Component, so it is invoked as a function with mocked session / org /
 * oRPC / navigation imports.
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

vi.mock("@saas/projects/components/publishing-suite", () => ({
	TopicItemPage: () => null,
}));

const PROJECT_ID = "proj-1";
const TOPIC_ID = "topic-1";
const ORG_ID = "org-A";
const ORG_SLUG = "example-org";

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.resetModules();
});

async function callPage() {
	const mod = await import(
		"../../../../app/(saas)/app/(organizations)/[organizationSlug]/projects/[id]/publishing/[topicId]/page"
	);
	return (
		mod.default as (args: {
			params: Promise<{
				id: string;
				topicId: string;
				organizationSlug: string;
			}>;
		}) => Promise<unknown>
	)({
		params: Promise.resolve({
			id: PROJECT_ID,
			topicId: TOPIC_ID,
			organizationSlug: ORG_SLUG,
		}),
	});
}

describe("Organization Publishing Suite topic page — route guard", () => {
	it("the per-organization gate is the only availability gate, and it is consulted for the resolved organization", async () => {
		// Both directions, on the route where a guessed URL is the threat: off
		// refuses before the project is ever fetched, on renders. The
		// `toHaveBeenLastCalledWith` is what stops the render half passing for
		// a route that consults no gate at all — without it, deleting the gate
		// would only fail the refusal half.
		mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
		mockGetActiveOrganization.mockResolvedValue({ id: ORG_ID });
		mockProjectsGet.mockResolvedValue({ project: { canPublish: true } });

		mockIsFeatureEnabled.mockResolvedValue(false);
		await expect(callPage()).rejects.toThrow(/__NOT_FOUND__/);
		expect(mockNotFound).toHaveBeenCalledTimes(1);
		expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
			"PUBLISHING_SUITE",
			ORG_ID,
		);
		// Gated before any project access, exactly as the list route is.
		expect(mockProjectsGet).not.toHaveBeenCalled();

		mockIsFeatureEnabled.mockResolvedValue(true);
		await expect(callPage()).resolves.toBeDefined();
		expect(mockIsFeatureEnabled).toHaveBeenLastCalledWith(
			"PUBLISHING_SUITE",
			ORG_ID,
		);
		expect(mockNotFound).toHaveBeenCalledTimes(1);
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

	it("rejects a caller without project access with notFound()", async () => {
		mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
		mockGetActiveOrganization.mockResolvedValue({ id: ORG_ID });
		mockIsFeatureEnabled.mockResolvedValue(true);
		mockProjectsGet.mockRejectedValue(new Error("NOT_FOUND"));

		await expect(callPage()).rejects.toThrow(/__NOT_FOUND__/);
		expect(mockNotFound).toHaveBeenCalledTimes(1);
	});

	it("passes the topic id, the RESOLVED org id and canEdit through on the happy path", async () => {
		mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
		mockGetActiveOrganization.mockResolvedValue({ id: ORG_ID });
		mockIsFeatureEnabled.mockResolvedValue(true);
		mockProjectsGet.mockResolvedValue({ project: { canPublish: true } });

		const result = (await callPage()) as { props: Record<string, unknown> };

		expect(result.props.projectId).toBe(PROJECT_ID);
		expect(result.props.topicId).toBe(TOPIC_ID);
		expect(result.props.organizationId).toBe(ORG_ID);
		expect(result.props.canEdit).toBe(true);
		// F2: the RESOLVED org id, never `null` — passing `null` searches
		// personal projects only and would 404 an org member authorized
		// through their org role rather than a `ProjectMember` row.
		expect(mockProjectsGet).toHaveBeenCalledWith({
			id: PROJECT_ID,
			organizationId: ORG_ID,
		});
	});

	it("renders with canEdit=false for a caller without publish rights", async () => {
		mockGetSession.mockResolvedValue({ user: { id: "viewer-1" } });
		mockGetActiveOrganization.mockResolvedValue({ id: ORG_ID });
		mockIsFeatureEnabled.mockResolvedValue(true);
		mockProjectsGet.mockResolvedValue({ project: { canPublish: false } });

		const result = (await callPage()) as { props: Record<string, unknown> };
		expect(result.props.canEdit).toBe(false);
	});
});
