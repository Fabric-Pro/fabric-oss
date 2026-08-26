import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

vi.mock("@repo/auth/lib/helper", () => ({
	isOrganizationAdmin: () => false,
}));

vi.mock("@repo/config", () => ({
	config: { organizations: { enableBilling: false } },
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ session: { userId: "u-1" }, user: { id: "u-1" } }),
}));

vi.mock("@saas/auth/lib/api", () => ({ sessionQueryKey: ["session"] }));

vi.mock("@saas/organizations/lib/api", () => ({
	activeOrganizationQueryKey: (slug: string) => ["active-org", slug],
	useActiveOrganizationQuery: () => ({ data: undefined }),
}));

vi.mock("@shared/hooks/router", () => ({
	useRouter: () => ({ push: pushMock }),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: { payments: { listPurchases: { queryOptions: () => ({}) } } },
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
vi.mock("next/navigation", () => ({
	useParams: () => paramsMock,
}));

vi.mock("nprogress", () => ({
	default: { start: vi.fn(), done: vi.fn() },
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

vi.mock("sonner", () => ({ toast: { error: toastErrorMock } }));

import { ActiveOrganizationProvider } from "@saas/organizations/components/ActiveOrganizationProvider";
import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";

function SwitchProbe({ target }: { target: string | null }) {
	const { setActiveOrganization, isSwitching } = useActiveOrganization();
	return (
		<div>
			<span data-testid="state">
				{isSwitching ? "switching" : "idle"}
			</span>
			<button type="button" onClick={() => setActiveOrganization(target)}>
				switch
			</button>
		</div>
	);
}

describe("ActiveOrganizationProvider — switch guard", () => {
	beforeEach(() => {
		setActiveMock.mockReset();
		pushMock.mockReset();
		toastErrorMock.mockReset();
		paramsMock = {};
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("ignores repeat switch requests while one is in flight (AC3)", async () => {
		// Never resolves → the first switch stays in flight.
		setActiveMock.mockReturnValue(new Promise(() => {}));
		const user = userEvent.setup();

		render(
			<ActiveOrganizationProvider>
				<SwitchProbe target="globex" />
			</ActiveOrganizationProvider>,
		);

		const button = screen.getByRole("button", { name: "switch" });
		await user.click(button);
		await user.click(button);
		await user.click(button);

		expect(setActiveMock).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId("state")).toHaveTextContent("switching");
	});

	it("is a no-op when selecting the already-active workspace", async () => {
		paramsMock = { organizationSlug: "globex" };
		const user = userEvent.setup();

		render(
			<ActiveOrganizationProvider>
				<SwitchProbe target="globex" />
			</ActiveOrganizationProvider>,
		);

		await user.click(screen.getByRole("button", { name: "switch" }));
		expect(setActiveMock).not.toHaveBeenCalled();
		expect(screen.getByTestId("state")).toHaveTextContent("idle");
	});

	it("clears the in-flight state and surfaces an error when the switch fails", async () => {
		setActiveMock.mockRejectedValue(new Error("network"));
		const user = userEvent.setup();

		render(
			<ActiveOrganizationProvider>
				<SwitchProbe target="globex" />
			</ActiveOrganizationProvider>,
		);

		await user.click(screen.getByRole("button", { name: "switch" }));

		expect(setActiveMock).toHaveBeenCalledTimes(1);
		expect(toastErrorMock).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId("state")).toHaveTextContent("idle");
	});

	it("navigates to the target workspace immediately, before setActive resolves (optimistic)", async () => {
		// setActive never resolves — navigation must NOT wait for it, so a
		// click made while it loads stays within the new workspace.
		setActiveMock.mockReturnValue(new Promise(() => {}));
		const user = userEvent.setup();

		render(
			<ActiveOrganizationProvider>
				<SwitchProbe target="globex" />
			</ActiveOrganizationProvider>,
		);

		await user.click(screen.getByRole("button", { name: "switch" }));

		// Pushed to the target right away, even though setActive is pending.
		expect(pushMock).toHaveBeenCalledWith("/app/globex");
	});

	it("rolls back to the previous workspace and surfaces an error when an org switch resolves to null", async () => {
		// From personal context, request an org but the server returns no org
		// (e.g. a revoked membership) — the optimistic nav must be undone.
		setActiveMock.mockResolvedValue({ data: null, error: null });
		const user = userEvent.setup();

		render(
			<ActiveOrganizationProvider>
				<SwitchProbe target="globex" />
			</ActiveOrganizationProvider>,
		);

		await user.click(screen.getByRole("button", { name: "switch" }));

		expect(setActiveMock).toHaveBeenCalledTimes(1);
		// Optimistically navigated to the org first...
		expect(pushMock).toHaveBeenCalledWith("/app/globex");
		await waitFor(() => {
			// ...then rolled back to personal and surfaced the error, not stuck.
			expect(toastErrorMock).toHaveBeenCalledTimes(1);
			expect(pushMock).toHaveBeenCalledWith("/app");
			expect(screen.getByTestId("state")).toHaveTextContent("idle");
		});
	});

	it("recovers via the watchdog if a switch never commits its route", () => {
		vi.useFakeTimers();
		// Never resolves and the URL never changes → only the watchdog can
		// release the in-flight state.
		setActiveMock.mockReturnValue(new Promise(() => {}));

		render(
			<ActiveOrganizationProvider>
				<SwitchProbe target="globex" />
			</ActiveOrganizationProvider>,
		);

		act(() => {
			fireEvent.click(screen.getByRole("button", { name: "switch" }));
		});
		expect(screen.getByTestId("state")).toHaveTextContent("switching");

		act(() => {
			vi.advanceTimersByTime(12_000);
		});
		expect(screen.getByTestId("state")).toHaveTextContent("idle");
	});
});
