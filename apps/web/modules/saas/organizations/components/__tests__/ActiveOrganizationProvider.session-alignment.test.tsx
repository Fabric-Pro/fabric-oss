/**
 * Aligning `session.activeOrganizationId` with the organization on screen.
 *
 * WHY THIS EXISTS (Fizzy #1875)
 *
 * Landing on /app/{slug} does not move the session by itself. The post-login
 * hop writes the session row with Prisma; a bare /app load redirects into the
 * first membership and writes nothing. Either way the API can still disagree,
 * because `protectedProcedure` reads the session through Better Auth's signed
 * `session_data` cookie — a five-minute snapshot that a database write cannot
 * touch. Until it expires, `tenantContextMiddleware` builds its tenant context
 * from the organization the caller has left, and any oRPC call that falls back
 * to the session (rather than passing an explicit, URL-derived organization id)
 * resolves against the wrong tenant.
 *
 * Only a caller that can set cookies closes that, which a Server Component
 * cannot — so the client does it via the same `setActive` the switcher uses,
 * which refreshes the cookie cache and the row together.
 *
 * These tests pin that it fires exactly when the two disagree, stays silent
 * when they agree, and never turns a background correction into something the
 * user has to see.
 */

import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { setActiveMock, pushMock, toastErrorMock } = vi.hoisted(() => ({
	setActiveMock: vi.fn(),
	pushMock: vi.fn(),
	toastErrorMock: vi.fn(),
}));

vi.mock("@repo/auth/client", () => ({
	authClient: {
		organization: {
			setActive: (...args: unknown[]) => setActiveMock(...args),
		},
	},
}));

vi.mock("@repo/auth/lib/helper", () => ({ isOrganizationAdmin: () => false }));

vi.mock("@repo/config", () => ({
	config: { organizations: { enableBilling: false } },
}));

let sessionMock: { activeOrganizationId?: string | null } | undefined;
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ session: sessionMock, user: { id: "u-1" } }),
}));

vi.mock("@saas/auth/lib/api", () => ({ sessionQueryKey: ["session"] }));

let activeOrganizationMock:
	| { id: string; slug: string; members: unknown[] }
	| undefined;
vi.mock("@saas/organizations/lib/api", () => ({
	activeOrganizationQueryKey: (slug: string) => ["active-org", slug],
	useActiveOrganizationQuery: () => ({ data: activeOrganizationMock }),
}));

vi.mock("@shared/hooks/router", () => ({
	useRouter: () => ({ push: pushMock }),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: { payments: { listPurchases: { queryOptions: () => ({}) } } },
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { users: { updateLastActiveWorkspace: vi.fn() } },
}));

const queryClientStub = {
	setQueryData: vi.fn(),
	invalidateQueries: vi.fn().mockResolvedValue(undefined),
	refetchQueries: vi.fn().mockResolvedValue(undefined),
	prefetchQuery: vi.fn().mockResolvedValue(undefined),
};
vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => queryClientStub,
}));

let paramsMock: Record<string, string | undefined>;
vi.mock("next/navigation", () => ({ useParams: () => paramsMock }));

vi.mock("nprogress", () => ({ default: { start: vi.fn(), done: vi.fn() } }));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

vi.mock("sonner", () => ({ toast: { error: toastErrorMock } }));

import { ActiveOrganizationProvider } from "@saas/organizations/components/ActiveOrganizationProvider";

/** Only alignment log lines, so React/jsdom noise cannot pass or fail a test. */
function alignmentLogs(spy: ReturnType<typeof vi.spyOn>) {
	return spy.mock.calls.filter(
		(call) =>
			typeof call[0] === "string" &&
			call[0].includes("[ActiveOrganizationProvider]"),
	);
}

function renderProvider() {
	return render(
		<ActiveOrganizationProvider>
			<div>child</div>
		</ActiveOrganizationProvider>,
	);
}

describe("session alignment with the workspace on screen", () => {
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		paramsMock = { organizationSlug: "example-org" };
		activeOrganizationMock = {
			id: "org-2",
			slug: "example-org",
			members: [],
		};
		sessionMock = { activeOrganizationId: "org-1" };
		setActiveMock.mockResolvedValue({ data: { id: "org-2" }, error: null });
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();
	});

	it("moves the session onto the organization the URL is showing", async () => {
		renderProvider();

		await waitFor(() => {
			expect(setActiveMock).toHaveBeenCalledWith({
				organizationId: "org-2",
			});
		});
		// The cached session has to follow, or the effect sees a stale value and
		// fires again on the next render.
		await waitFor(() => {
			expect(queryClientStub.setQueryData).toHaveBeenCalledWith(
				["session"],
				expect.any(Function),
			);
		});
	});

	it("stays silent when the session already names it", async () => {
		sessionMock = { activeOrganizationId: "org-2" };

		renderProvider();

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(setActiveMock).not.toHaveBeenCalled();
	});

	it("does nothing on a bare /app load with no organization in the URL", async () => {
		// The provider mounts above both route groups, so it renders here too.
		// Nothing is on screen to align to.
		paramsMock = {};
		activeOrganizationMock = undefined;

		renderProvider();

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(setActiveMock).not.toHaveBeenCalled();
	});

	it("logs a refusal without a toast or a navigation", async () => {
		// The page is already showing the right organization and the user asked
		// for nothing here — a failure must not interrupt them.
		setActiveMock.mockResolvedValue({
			data: null,
			error: new Error("network"),
		});

		renderProvider();

		await waitFor(() => {
			expect(alignmentLogs(consoleErrorSpy)).toHaveLength(1);
		});
		expect(toastErrorMock).not.toHaveBeenCalled();
		expect(pushMock).not.toHaveBeenCalled();
	});

	it("does not retry the same organization after a refusal", async () => {
		// A retry loop here would issue a request on every render for as long as
		// the user stays on the page. Re-rendering with identical props proves
		// nothing — React skips the effect when no dependency changed — so the
		// organization object is replaced with a NEW reference carrying the SAME
		// id, which is what a refetch produces and what genuinely re-runs it.
		setActiveMock.mockResolvedValue({
			data: null,
			error: new Error("network"),
		});

		const { rerender } = renderProvider();
		await waitFor(() => expect(setActiveMock).toHaveBeenCalledTimes(1));

		activeOrganizationMock = {
			id: "org-2",
			slug: "example-org",
			members: [],
		};
		rerender(
			<ActiveOrganizationProvider>
				<div>child</div>
			</ActiveOrganizationProvider>,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(setActiveMock).toHaveBeenCalledTimes(1);
	});
});
