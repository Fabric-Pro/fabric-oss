/**
 * Tests for the server-side role-tag gate logic in the authenticated app
 * layout (Fizzy #2264).
 *
 * `apps/web/app/(saas)/app/layout.tsx` resolves whether the current user has
 * any default function tags and hands the tri-state result to
 * `RoleTagSnapshotProvider`, so the blocking role-tag gate
 * (`FunctionTagsRequiredGate.tsx`) is correct on first paint. Three
 * mechanisms guard that value and are each independently pinned below:
 *   - the `featureFlags.ROLE_TAG_ENFORCEMENT` guard — off means
 *     `getUserDefaultFunctionTags` is never called and the snapshot stays
 *     `null`
 *   - the try/catch around the DB read — a rejection must not throw through
 *     the layout; it degrades to a `null` snapshot and logs a warning
 *   - the `defaultTags.length > 0` mapping to a boolean snapshot
 *
 * Because the layout is a React Server Component, it can't be rendered
 * through @testing-library — this invokes the exported function directly
 * with mocked `@repo/database` / session / navigation imports and asserts
 * on the returned element tree, mirroring
 * `apps/web/__tests__/app/projects/publishing/personal-page-guard.test.tsx`
 * and `apps/web/__tests__/app/admin/audit-log-explorer/page-guard.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockGetSession,
	mockGetOrganizationList,
	mockRedirect,
	mockGetAllFlags,
	mockGetUserDefaultFunctionTags,
} = vi.hoisted(() => ({
	mockGetSession: vi.fn(),
	mockGetOrganizationList: vi.fn(),
	mockRedirect: vi.fn(),
	mockGetAllFlags: vi.fn(),
	mockGetUserDefaultFunctionTags: vi.fn(),
}));

vi.mock("@saas/auth/lib/server", () => ({
	getSession: () => mockGetSession(),
	getOrganizationList: () => mockGetOrganizationList(),
}));

vi.mock("next/navigation", () => ({
	redirect: (target: string) => {
		mockRedirect(target);
		throw new Error(`__REDIRECT__:${target}`);
	},
}));

vi.mock("@repo/database", () => ({
	getAllFlags: () => mockGetAllFlags(),
	getUserDefaultFunctionTags: (userId: string) =>
		mockGetUserDefaultFunctionTags(userId),
}));

// Never reached by these tests — the billing gate short-circuits on the
// project's always-on free plan before touching oRPC — but the layout
// imports it at module scope, so it needs a harmless stand-in.
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		payments: {
			listPurchases: vi.fn(),
		},
	},
}));

const USER_ID = "user-1";

function baseSession() {
	return {
		user: {
			id: USER_ID,
			mustChangePassword: false,
			onboardingComplete: true,
		},
		session: {
			activeOrganizationId: null,
		},
	};
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	mockGetOrganizationList.mockResolvedValue([]);
	warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.resetModules();
	warnSpy.mockRestore();
});

async function callLayout() {
	const mod = await import("../../../app/(saas)/app/layout");
	return (
		mod.default as (props: { children: unknown }) => Promise<{
			props: {
				value: unknown;
				children: { props: { value: unknown } };
			};
		}>
	)({ children: null });
}

describe("(saas)/app layout — role-tag gate snapshot (Fizzy #2264)", () => {
	it("never reads default function tags when the flag is off, and passes a null snapshot", async () => {
		mockGetSession.mockResolvedValue(baseSession());
		mockGetAllFlags.mockResolvedValue({ ROLE_TAG_ENFORCEMENT: false });

		const result = await callLayout();

		expect(mockGetUserDefaultFunctionTags).not.toHaveBeenCalled();
		expect(result.props.children.props.value).toBeNull();
	});

	it("passes snapshot=true when the flag is on and the user has default tags", async () => {
		mockGetSession.mockResolvedValue(baseSession());
		mockGetAllFlags.mockResolvedValue({ ROLE_TAG_ENFORCEMENT: true });
		mockGetUserDefaultFunctionTags.mockResolvedValue(["DEVELOPER"]);

		const result = await callLayout();

		expect(mockGetUserDefaultFunctionTags).toHaveBeenCalledWith(USER_ID);
		expect(result.props.children.props.value).toBe(true);
	});

	it("passes snapshot=false when the flag is on and the user has no default tags", async () => {
		mockGetSession.mockResolvedValue(baseSession());
		mockGetAllFlags.mockResolvedValue({ ROLE_TAG_ENFORCEMENT: true });
		mockGetUserDefaultFunctionTags.mockResolvedValue([]);

		const result = await callLayout();

		expect(result.props.children.props.value).toBe(false);
	});

	it("degrades to a null snapshot and logs a warning when the read rejects, without throwing", async () => {
		mockGetSession.mockResolvedValue(baseSession());
		mockGetAllFlags.mockResolvedValue({ ROLE_TAG_ENFORCEMENT: true });
		mockGetUserDefaultFunctionTags.mockRejectedValue(new Error("db down"));

		const result = await callLayout();

		expect(result.props.children.props.value).toBeNull();
		expect(warnSpy).toHaveBeenCalledWith(
			"[AppLayout] Failed to read default function tags; role-tag gate staying shut",
			expect.any(Error),
		);
	});
});
