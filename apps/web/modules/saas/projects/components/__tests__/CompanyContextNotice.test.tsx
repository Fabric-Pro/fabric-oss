/**
 * The empty company context notice in document creation (Fizzy #2719).
 *
 * What is pinned here is the component's own contract; where it mounts in the
 * create dialog is pinned by `CreateDocumentDialog.test.tsx`.
 *
 *   - `empty` and `notReady` each show their own copy and link to the
 *     organization's company context settings page.
 *   - `hidden` shows nothing.
 *   - Nothing renders before the query has answered, and nothing on a failed
 *     read.
 *   - A guest, a flag-off tenant and a route without an organization never
 *     ask the server at all.
 *   - There is no dismissal: the link is the notice's only control.
 *
 * `next-intl` echoes the key, so every copy assertion targets a KEY.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { noticeState, flagEnabled, isGuest } = vi.hoisted(() => ({
	noticeState: vi.fn(),
	flagEnabled: vi.fn(() => true),
	isGuest: vi.fn(() => false),
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({
		push: vi.fn(),
		replace: vi.fn(),
		prefetch: vi.fn(),
		back: vi.fn(),
	}),
	usePathname: () => "/",
	useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) =>
		key === "COMPANY_CONTEXT" ? flagEnabled() : false,
}));

vi.mock("@saas/organizations/hooks/use-is-guest-in-org", () => ({
	useIsGuestInOrg: () => isGuest(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		organizations: {
			companyContext: {
				noticeState: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: [
							"organizations.companyContext.noticeState",
							input,
						],
						queryFn: () => noticeState(input),
					}),
				},
			},
		},
	},
}));

import { CompanyContextNotice } from "../CompanyContextNotice";

type NoticeProps = React.ComponentProps<typeof CompanyContextNotice>;

function renderNotice(overrides: Partial<NoticeProps> = {}) {
	// `retry: false` so a failed read settles on the first rejection rather
	// than sitting in the retrying state.
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<CompanyContextNotice
				projectId="project-1"
				organizationSlug="example-org"
				{...overrides}
			/>
		</QueryClientProvider>,
	);
}

/** A promise the test resolves or rejects when it chooses. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const notice = () => screen.queryByTestId("company-context-notice");

describe("CompanyContextNotice", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		flagEnabled.mockReturnValue(true);
		isGuest.mockReturnValue(false);
	});

	it("an empty company context shows the notice with a link to its settings page", async () => {
		noticeState.mockResolvedValue({ state: "empty" });
		renderNotice();

		const region = await screen.findByRole("note", {
			name: "empty.title",
		});
		expect(region).toHaveTextContent("empty.body");
		// The project is sent; the server resolves the organization from it.
		expect(noticeState).toHaveBeenCalledWith({ projectId: "project-1" });

		const link = screen.getByRole("link", { name: "openSettings" });
		expect(link).toHaveAttribute(
			"href",
			"/app/example-org/settings/company-context",
		);
	});

	it("shows the not-ready copy when sources exist but none is ready", async () => {
		noticeState.mockResolvedValue({ state: "notReady" });
		renderNotice();

		const region = await screen.findByRole("note", {
			name: "notReady.title",
		});
		expect(region).toHaveTextContent("notReady.body");
		expect(region).not.toHaveTextContent("empty.body");
		expect(
			screen.getByRole("link", { name: "openSettings" }),
		).toHaveAttribute("href", "/app/example-org/settings/company-context");
	});

	it("shows nothing when the server answers hidden", async () => {
		noticeState.mockResolvedValue({ state: "hidden" });
		const { container } = renderNotice();

		await waitFor(() => expect(noticeState).toHaveBeenCalledTimes(1));
		// Let the resolved answer reach the component before asserting.
		await waitFor(() => expect(notice()).toBeNull());
		expect(container).toBeEmptyDOMElement();
	});

	it("renders nothing before the query answers, then the notice once it answers empty", async () => {
		const answer = deferred<{ state: string }>();
		noticeState.mockReturnValue(answer.promise);
		const { container } = renderNotice();

		await waitFor(() => expect(noticeState).toHaveBeenCalledTimes(1));
		// No placeholder, no skeleton, no guess: an unanswered read is not
		// read as `empty`.
		expect(container).toBeEmptyDOMElement();

		answer.resolve({ state: "empty" });
		expect(
			await screen.findByRole("note", { name: "empty.title" }),
		).toBeInTheDocument();
	});

	it("renders nothing when the notice-state read fails", async () => {
		const answer = deferred<{ state: string }>();
		noticeState.mockReturnValue(answer.promise);
		const { container } = renderNotice();

		await waitFor(() => expect(noticeState).toHaveBeenCalledTimes(1));
		answer.reject(new Error("notice state unavailable"));

		// Give the rejection a chance to settle, then confirm nothing appeared.
		await waitFor(() => expect(container).toBeEmptyDOMElement());
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(container).toBeEmptyDOMElement();
	});

	it("never asks the server for a guest", async () => {
		isGuest.mockReturnValue(true);
		noticeState.mockResolvedValue({ state: "empty" });
		const { container } = renderNotice();

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(noticeState).not.toHaveBeenCalled();
		expect(container).toBeEmptyDOMElement();
	});

	it("never asks the server when the company context flag is off", async () => {
		flagEnabled.mockReturnValue(false);
		noticeState.mockResolvedValue({ state: "empty" });
		const { container } = renderNotice();

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(noticeState).not.toHaveBeenCalled();
		expect(container).toBeEmptyDOMElement();
	});

	it("never asks the server without an organization to link to", async () => {
		noticeState.mockResolvedValue({ state: "empty" });
		const { container } = renderNotice({ organizationSlug: null });

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(noticeState).not.toHaveBeenCalled();
		expect(container).toBeEmptyDOMElement();
	});

	it("offers no dismissal — the settings link is its only control", async () => {
		noticeState.mockResolvedValue({ state: "empty" });
		renderNotice();

		const region = await screen.findByRole("note", {
			name: "empty.title",
		});
		// Nothing to remember, so nothing to dismiss.
		expect(screen.queryByRole("button")).toBeNull();
		expect(region.querySelectorAll("a, button")).toHaveLength(1);
		// Advice, not an alarm: never announced assertively.
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("runs the caller's navigate hook when the link is followed", async () => {
		const user = userEvent.setup();
		const onNavigate = vi.fn();
		noticeState.mockResolvedValue({ state: "empty" });
		renderNotice({ onNavigate });

		const link = await screen.findByRole("link", { name: "openSettings" });
		// jsdom does not navigate; the click handler is what is under test.
		link.addEventListener("click", (event) => event.preventDefault());
		await user.click(link);
		expect(onNavigate).toHaveBeenCalledTimes(1);
	});
});
