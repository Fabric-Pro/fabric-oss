/**
 * The high-contrast theme in the browser (Fizzy #1444).
 *
 * What a person sees has to change the moment they ask for it and stay changed
 * whatever the server says about saving it; what the account holds has to end
 * up being their last choice. These tests pin both halves, and the boundary
 * with the colour mode: high contrast never touches `.dark` or the colour
 * mode's storage (AC-12).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mutateMock, toastErrorMock, toastInfoMock } = vi.hoisted(() => ({
	mutateMock: vi.fn(),
	toastErrorMock: vi.fn(),
	toastInfoMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		users: {
			appearance: {
				update: {
					mutationOptions: () => ({
						mutationFn: (input: unknown) => mutateMock(input),
					}),
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { error: toastErrorMock, info: toastInfoMock },
}));

vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => (key: string) =>
		`${namespace}.${key}`,
}));

import {
	ContrastPreferenceProvider,
	useContrastPreference,
} from "@saas/shared/components/ContrastPreferenceProvider";

const UNSAVED_KEY = "fabric-contrast-unsaved";
const USER = "user_a";
const unsaved = (preference: string, userId = USER) =>
	JSON.stringify({ userId, preference });
const storedUnsaved = () => {
	const raw = window.sessionStorage.getItem(UNSAVED_KEY);
	return raw
		? (JSON.parse(raw) as { userId: string; preference: string })
		: null;
};

type Api = NonNullable<ReturnType<typeof useContrastPreference>>;
let api: Api | null = null;

function Probe() {
	const value = useContrastPreference();
	api = value;
	return <span data-testid="state">{value?.preference ?? "none"}</span>;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function renderProvider(
	initialPreference: "standard" | "high",
	extra?: ReactNode,
) {
	const queryClient = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	const ui = (preference: "standard" | "high") => (
		<QueryClientProvider client={queryClient}>
			<ContrastPreferenceProvider
				initialPreference={preference}
				userId={USER}
			>
				<Probe />
				{extra}
			</ContrastPreferenceProvider>
		</QueryClientProvider>
	);
	const result = render(ui(initialPreference));
	return {
		...result,
		queryClient,
		rerenderWith: (preference: "standard" | "high") =>
			result.rerender(ui(preference)),
	};
}

const html = () => document.documentElement;

beforeEach(() => {
	html().className = "";
	window.sessionStorage.clear();
	window.localStorage.clear();
	mutateMock.mockReset();
	mutateMock.mockImplementation(
		async (input: { contrastPreference: string }) => ({
			contrastPreference: input.contrastPreference,
			persisted: true,
		}),
	);
	toastErrorMock.mockReset();
	toastInfoMock.mockReset();
	api = null;
});

afterEach(() => {
	html().className = "";
});

describe("ContrastPreferenceProvider", () => {
	it("paints the account's choice on mount and takes it off on unmount", () => {
		const { unmount } = renderProvider("high");
		expect(html()).toHaveClass("high-contrast");
		expect(screen.getByTestId("state")).toHaveTextContent("high");

		// Leaving the authenticated app for a public page: out of scope for
		// v1, so it must not inherit the class.
		unmount();
		expect(html()).not.toHaveClass("high-contrast");
	});

	it("leaves the standard palette alone when the account has not chosen", () => {
		renderProvider("standard");
		expect(html()).not.toHaveClass("high-contrast");
	});

	it("applies the palette synchronously, before the save has answered (AC-2)", async () => {
		const save = deferred<{
			contrastPreference: string;
			persisted: boolean;
		}>();
		mutateMock.mockReturnValueOnce(save.promise);
		renderProvider("standard");

		act(() => api?.setHighContrast(true));

		// Same task as the click: nothing has been awaited yet, and TanStack
		// has not even started the request.
		expect(html()).toHaveClass("high-contrast");
		await waitFor(() =>
			expect(mutateMock).toHaveBeenCalledWith({
				contrastPreference: "high",
			}),
		);
		// Still pending, still applied.
		expect(html()).toHaveClass("high-contrast");

		await act(async () => {
			save.resolve({ contrastPreference: "high", persisted: true });
		});
		expect(html()).toHaveClass("high-contrast");
		expect(toastErrorMock).not.toHaveBeenCalled();
	});

	it("reverts immediately when turned off (AC-3)", async () => {
		renderProvider("high");

		act(() => api?.setHighContrast(false));

		expect(html()).not.toHaveClass("high-contrast");
		await waitFor(() =>
			expect(mutateMock).toHaveBeenCalledWith({
				contrastPreference: "standard",
			}),
		);
	});

	it("keeps the palette and says so when the save fails (AC-7)", async () => {
		mutateMock.mockRejectedValueOnce(new Error("503"));
		renderProvider("standard");

		act(() => api?.setHighContrast(true));

		await waitFor(() =>
			expect(toastErrorMock).toHaveBeenCalledWith(
				"settings.account.appearance.notifications.saveFailed",
			),
		);
		// Still on: undoing it would hand the person back the palette they
		// just said they cannot read.
		expect(html()).toHaveClass("high-contrast");
		expect(screen.getByTestId("state")).toHaveTextContent("high");
		// And remembered for a reload of this tab, for this account only.
		expect(storedUnsaved()).toEqual({ userId: USER, preference: "high" });
	});

	it("applies but neither saves nor keeps the choice while an admin impersonates", async () => {
		mutateMock.mockResolvedValueOnce({
			contrastPreference: "high",
			persisted: false,
		});
		renderProvider("standard");

		act(() => api?.setHighContrast(true));

		await waitFor(() =>
			expect(toastInfoMock).toHaveBeenCalledWith(
				"settings.account.appearance.notifications.notSavedWhileImpersonating",
			),
		);
		expect(html()).toHaveClass("high-contrast");
		expect(toastErrorMock).not.toHaveBeenCalled();
		// No record: a retry after the impersonation ended would write the
		// choice to the admin's own account.
		expect(storedUnsaved()).toBeNull();
	});

	it("after a failed save, a reload keeps the tab's choice and retries it quietly", async () => {
		window.sessionStorage.setItem(UNSAVED_KEY, unsaved("high"));
		renderProvider("standard");

		// The tab's choice wins over the account's stale one at once...
		expect(html()).toHaveClass("high-contrast");
		// ...and is sent again, without a second toast for the same failure.
		await waitFor(() =>
			expect(mutateMock).toHaveBeenCalledWith({
				contrastPreference: "high",
			}),
		);
		await waitFor(() =>
			expect(window.sessionStorage.getItem(UNSAVED_KEY)).toBeNull(),
		);
		expect(toastErrorMock).not.toHaveBeenCalled();
		expect(toastInfoMock).not.toHaveBeenCalled();
	});

	it("ignores another account's unsaved choice left in the tab", async () => {
		// Someone else signed out of this tab after a failed save.
		window.sessionStorage.setItem(UNSAVED_KEY, unsaved("high", "user_b"));
		renderProvider("standard");

		await act(async () => {});
		expect(html()).not.toHaveClass("high-contrast");
		// And it is never saved to this account.
		expect(mutateMock).not.toHaveBeenCalled();
	});

	it("ignores a malformed record", async () => {
		window.sessionStorage.setItem(UNSAVED_KEY, "high");
		renderProvider("standard");
		await act(async () => {});
		expect(html()).not.toHaveClass("high-contrast");
		expect(mutateMock).not.toHaveBeenCalled();
	});

	it("drops a stale unsaved choice the account already matches", async () => {
		window.sessionStorage.setItem(UNSAVED_KEY, unsaved("high"));
		renderProvider("high");

		await waitFor(() =>
			expect(window.sessionStorage.getItem(UNSAVED_KEY)).toBeNull(),
		);
		expect(mutateMock).not.toHaveBeenCalled();
		expect(html()).toHaveClass("high-contrast");
	});

	it("does not toast when a retried save fails again", async () => {
		window.sessionStorage.setItem(UNSAVED_KEY, unsaved("high"));
		mutateMock.mockRejectedValueOnce(new Error("503"));
		renderProvider("standard");

		await waitFor(() => expect(mutateMock).toHaveBeenCalledTimes(1));
		await act(async () => {});
		expect(toastErrorMock).not.toHaveBeenCalled();
		expect(storedUnsaved()).toEqual({ userId: USER, preference: "high" });
		expect(html()).toHaveClass("high-contrast");
	});

	it("serialises saves so the account ends on the last choice", async () => {
		const first = deferred<{
			contrastPreference: string;
			persisted: boolean;
		}>();
		mutateMock.mockReturnValueOnce(first.promise);
		renderProvider("standard");

		act(() => api?.setHighContrast(true));
		act(() => api?.setHighContrast(false));
		act(() => api?.setHighContrast(true));
		act(() => api?.setHighContrast(false));

		// The screen already shows the last choice; one request is on the wire.
		expect(html()).not.toHaveClass("high-contrast");
		await waitFor(() => expect(mutateMock).toHaveBeenCalledTimes(1));
		await act(async () => {});
		expect(mutateMock).toHaveBeenCalledTimes(1);

		await act(async () => {
			first.resolve({ contrastPreference: "high", persisted: true });
		});

		await waitFor(() => expect(mutateMock).toHaveBeenCalledTimes(2));
		expect(mutateMock).toHaveBeenLastCalledWith({
			contrastPreference: "standard",
		});
		expect(html()).not.toHaveClass("high-contrast");
	});

	it("ignores the outcome of a save a later choice superseded", async () => {
		const first = deferred<{
			contrastPreference: string;
			persisted: boolean;
		}>();
		mutateMock.mockReturnValueOnce(first.promise);
		renderProvider("standard");

		act(() => api?.setHighContrast(true));
		act(() => api?.setHighContrast(false));
		await act(async () => {
			first.reject(new Error("503"));
		});

		// The failure belonged to "high", which is no longer what was asked
		// for; the "standard" save that follows decides what is said.
		await waitFor(() => expect(mutateMock).toHaveBeenCalledTimes(2));
		expect(toastErrorMock).not.toHaveBeenCalled();
	});

	it("adopts a newer value from the server when nothing is pending", async () => {
		const { rerenderWith } = renderProvider("standard");
		rerenderWith("high");
		await waitFor(() => expect(html()).toHaveClass("high-contrast"));
		expect(mutateMock).not.toHaveBeenCalled();
	});

	it("keeps the tab's own unsaved choice over a server value", async () => {
		mutateMock.mockRejectedValueOnce(new Error("503"));
		const { rerenderWith } = renderProvider("standard");
		act(() => api?.setHighContrast(true));
		await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());

		rerenderWith("standard");
		await act(async () => {});
		expect(html()).toHaveClass("high-contrast");
	});

	it("keeps the cached session in step with a saved choice", async () => {
		const { queryClient } = renderProvider("standard");
		queryClient.setQueryData(["user", "session"], {
			session: { id: "s" },
			user: { id: "u", contrastPreference: null },
		});

		act(() => api?.setHighContrast(true));

		await waitFor(() =>
			expect(
				queryClient.getQueryData<{
					user: { contrastPreference: string | null };
				}>(["user", "session"])?.user.contrastPreference,
			).toBe("high"),
		);
	});

	it("never touches the colour mode (AC-12)", async () => {
		html().classList.add("dark");
		window.localStorage.setItem("fabric-theme", "dark");
		renderProvider("standard");

		act(() => api?.setHighContrast(true));
		expect(html()).toHaveClass("dark", "high-contrast");

		act(() => api?.setHighContrast(false));
		expect(html()).toHaveClass("dark");
		expect(html()).not.toHaveClass("high-contrast");
		expect(window.localStorage.getItem("fabric-theme")).toBe("dark");
		await waitFor(() => expect(mutateMock).toHaveBeenCalled());
	});

	it("does nothing when asked for the value it already has", () => {
		renderProvider("high");
		act(() => api?.setHighContrast(true));
		expect(mutateMock).not.toHaveBeenCalled();
	});

	it("is absent outside the provider, so controls can hide themselves", () => {
		render(<Probe />);
		expect(screen.getByTestId("state")).toHaveTextContent("none");
	});
});
