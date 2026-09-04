import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	setActiveMock,
	pushMock,
	toastErrorMock,
	updateLastActiveWorkspaceMock,
} = vi.hoisted(() => ({
	setActiveMock: vi.fn(),
	pushMock: vi.fn(),
	toastErrorMock: vi.fn(),
	updateLastActiveWorkspaceMock: vi.fn(),
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

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		users: {
			updateLastActiveWorkspace: (...args: unknown[]) =>
				updateLastActiveWorkspaceMock(...args),
		},
	},
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
		updateLastActiveWorkspaceMock.mockReset();
		updateLastActiveWorkspaceMock.mockResolvedValue(undefined);
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

// `user.lastActiveOrganizationId` is what `resolveUserOrganization` reads to
// decide which organization the next session resolves into (including the one
// seeded at sign-in), so a dropped write here silently lands the user back in
// the workspace they switched away from. These pin the write as retried and,
// on total failure, loud — while staying entirely off the switch's own path.
describe("ActiveOrganizationProvider — last-active-workspace persistence", () => {
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

	// Only our own log lines; React/jsdom noise on console.error is ignored.
	const persistenceLogs = () =>
		consoleErrorSpy.mock.calls.filter(
			(call) =>
				typeof call[0] === "string" &&
				call[0].includes("[ActiveOrganizationProvider]"),
		);

	beforeEach(() => {
		setActiveMock.mockReset();
		pushMock.mockReset();
		toastErrorMock.mockReset();
		updateLastActiveWorkspaceMock.mockReset();
		queryClientStub.setQueryData.mockClear();
		paramsMock = {};
		consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		// The switch itself always succeeds in this block — only the
		// persistence write varies.
		setActiveMock.mockResolvedValue({
			data: { id: "org-globex" },
			error: null,
		});
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();
		vi.useRealTimers();
	});

	it("writes the new workspace id exactly once when persistence succeeds", async () => {
		updateLastActiveWorkspaceMock.mockResolvedValue(undefined);
		const user = userEvent.setup();

		render(
			<ActiveOrganizationProvider>
				<SwitchProbe target="globex" />
			</ActiveOrganizationProvider>,
		);

		await user.click(screen.getByRole("button", { name: "switch" }));

		await waitFor(() => {
			expect(updateLastActiveWorkspaceMock).toHaveBeenCalledTimes(1);
		});
		expect(updateLastActiveWorkspaceMock).toHaveBeenCalledWith({
			organizationId: "org-globex",
		});
		expect(persistenceLogs()).toHaveLength(0);
		expect(toastErrorMock).not.toHaveBeenCalled();
	});

	it("retries a transient failure and logs nothing once the write lands", async () => {
		vi.useFakeTimers();
		updateLastActiveWorkspaceMock
			.mockRejectedValueOnce(new Error("network blip"))
			.mockResolvedValueOnce(undefined);

		render(
			<ActiveOrganizationProvider>
				<SwitchProbe target="globex" />
			</ActiveOrganizationProvider>,
		);

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "switch" }));
		});
		// Drain the backoff without reaching the 12s switch watchdog.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_000);
		});

		expect(updateLastActiveWorkspaceMock).toHaveBeenCalledTimes(2);
		expect(updateLastActiveWorkspaceMock).toHaveBeenLastCalledWith({
			organizationId: "org-globex",
		});
		expect(persistenceLogs()).toHaveLength(0);
	});

	it("logs the loss once every attempt has failed", async () => {
		updateLastActiveWorkspaceMock.mockRejectedValue(new Error("offline"));
		vi.useFakeTimers();

		render(
			<ActiveOrganizationProvider>
				<SwitchProbe target="globex" />
			</ActiveOrganizationProvider>,
		);

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "switch" }));
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_000);
		});

		expect(updateLastActiveWorkspaceMock).toHaveBeenCalledTimes(3);
		const logs = persistenceLogs();
		expect(logs).toHaveLength(1);
		expect(logs[0][0]).toContain("last active workspace");
		expect(logs[0][1]).toBeInstanceOf(Error);
	});

	it("never rolls back, toasts, or undoes the switch when persistence fails", async () => {
		updateLastActiveWorkspaceMock.mockRejectedValue(new Error("offline"));
		vi.useFakeTimers();

		render(
			<ActiveOrganizationProvider>
				<SwitchProbe target="globex" />
			</ActiveOrganizationProvider>,
		);

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "switch" }));
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_000);
		});

		// The switch itself stands: navigated into the target and only there,
		// session cache updated, and the user is told nothing.
		expect(pushMock).toHaveBeenCalledWith("/app/globex");
		expect(pushMock).not.toHaveBeenCalledWith("/app");
		expect(queryClientStub.setQueryData).toHaveBeenCalledTimes(1);
		expect(toastErrorMock).not.toHaveBeenCalled();
	});

	it("abandons a stale retry once a newer switch has taken over", async () => {
		vi.useFakeTimers();
		// Each switch resolves to its own org, and only the first org's write
		// fails — so the first persist is still mid-backoff, holding a now-stale
		// organization id, when the second switch runs.
		setActiveMock.mockImplementation(
			async (input: { organizationSlug?: string }) => ({
				data: { id: `org-${input.organizationSlug}` },
				error: null,
			}),
		);
		updateLastActiveWorkspaceMock.mockImplementation(
			async (input: { organizationId: string | null }) => {
				if (input.organizationId === "org-globex") {
					throw new Error("network blip");
				}
			},
		);

		const { rerender } = render(
			<ActiveOrganizationProvider>
				<SwitchProbe target="globex" />
			</ActiveOrganizationProvider>,
		);

		// Switch one: personal -> globex. Its write fails and backs off.
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "switch" }));
		});
		expect(updateLastActiveWorkspaceMock).toHaveBeenCalledTimes(1);

		// The route commits — releasing the in-flight guard — and the user
		// switches straight on to a second workspace, inside that backoff.
		paramsMock = { organizationSlug: "globex" };
		await act(async () => {
			rerender(
				<ActiveOrganizationProvider>
					<SwitchProbe target="initech" />
				</ActiveOrganizationProvider>,
			);
		});
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "switch" }));
		});

		// Let the abandoned first persist's backoff elapse.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_000);
		});

		// The stale workspace was attempted once and never retried, so the
		// newer switch's write is the one left standing.
		const staleWrites = updateLastActiveWorkspaceMock.mock.calls.filter(
			([input]) => input.organizationId === "org-globex",
		);
		expect(staleWrites).toHaveLength(1);
		expect(updateLastActiveWorkspaceMock).toHaveBeenLastCalledWith({
			organizationId: "org-initech",
		});
		// Being superseded is not a failure — there is nothing to report.
		expect(persistenceLogs()).toHaveLength(0);
	});

	it("stays quiet when superseded during the final attempt, not just between them", async () => {
		vi.useFakeTimers();
		setActiveMock.mockImplementation(
			async (input: { organizationSlug?: string }) => ({
				data: { id: `org-${input.organizationSlug}` },
				error: null,
			}),
		);
		// The stale org's first two attempts fail outright; the third hangs, so
		// the newer switch lands while it is still in flight and the loop then
		// exits with an error in hand but no longer owning the field.
		let rejectFinalAttempt: (reason: unknown) => void = () => {};
		let staleAttempts = 0;
		updateLastActiveWorkspaceMock.mockImplementation(
			async (input: { organizationId: string | null }) => {
				if (input.organizationId !== "org-globex") {
					return;
				}
				staleAttempts++;
				if (staleAttempts < 3) {
					throw new Error("network blip");
				}
				return new Promise((_resolve, reject) => {
					rejectFinalAttempt = reject;
				});
			},
		);

		const { rerender } = render(
			<ActiveOrganizationProvider>
				<SwitchProbe target="globex" />
			</ActiveOrganizationProvider>,
		);

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "switch" }));
		});
		// Burn both backoffs so the third, hanging attempt is the live one.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1_000);
		});
		expect(staleAttempts).toBe(3);

		// The newer switch takes over while that third attempt is still open.
		paramsMock = { organizationSlug: "globex" };
		await act(async () => {
			rerender(
				<ActiveOrganizationProvider>
					<SwitchProbe target="initech" />
				</ActiveOrganizationProvider>,
			);
		});
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "switch" }));
		});

		// Only now does the stale attempt fail, exhausting the loop.
		await act(async () => {
			rejectFinalAttempt(new Error("offline"));
			await vi.advanceTimersByTimeAsync(1_000);
		});

		expect(updateLastActiveWorkspaceMock).toHaveBeenLastCalledWith({
			organizationId: "org-initech",
		});
		// Exhausted, but no longer the owner — the newer switch recorded its own
		// workspace, so nothing was lost and there is nothing to report.
		expect(persistenceLogs()).toHaveLength(0);
	});

	it("does not attempt the write at all when the switch itself fails", async () => {
		setActiveMock.mockRejectedValue(new Error("network"));
		const user = userEvent.setup();

		render(
			<ActiveOrganizationProvider>
				<SwitchProbe target="globex" />
			</ActiveOrganizationProvider>,
		);

		await user.click(screen.getByRole("button", { name: "switch" }));

		await waitFor(() => {
			expect(toastErrorMock).toHaveBeenCalledTimes(1);
		});
		expect(updateLastActiveWorkspaceMock).not.toHaveBeenCalled();
	});
});
