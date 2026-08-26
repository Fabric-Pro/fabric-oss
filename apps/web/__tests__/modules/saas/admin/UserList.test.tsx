/**
 * Tests for the admin UserList search/pagination wiring.
 * The API accepts { query, limit, offset }; the component previously sent
 * { searchTerm, currentPage, itemsPerPage } (stripped by Zod → search and
 * pagination were no-ops) and used a leading-only debounce (typing
 * "Avery" queried "A").
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockListUsers } = vi.hoisted(() => ({
	mockListUsers: vi.fn(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		admin: {
			users: {
				list: {
					key: () => ["admin", "users", "list"],
					queryOptions: (opts: { input: unknown }) => ({
						queryKey: ["admin", "users", "list", opts.input],
						queryFn: () => mockListUsers(opts.input),
					}),
				},
			},
		},
	},
}));

vi.mock("@repo/auth/client", () => ({
	authClient: { admin: {}, sendVerificationEmail: vi.fn() },
}));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: vi.fn() }),
}));

// next-intl is already mocked globally in vitest.setup.ts (useTranslations
// returns the key as-is); no local override needed here.

// vitest.setup.ts globally stubs `useDebounceValue` to a synchronous,
// timer-free passthrough (to avoid leaking usehooks-ts's uncancelled
// trailing-edge timers past test teardown). That stub can't distinguish a
// leading-only debounce from a trailing one — it echoes every keystroke
// immediately either way — so it would blind this test to the exact
// regression it exists to catch. Override it here with a *real* debounce
// that honors the `{ leading, trailing }` options usehooks-ts accepts (a
// leading edge publishes the value synchronously at the start of a burst; a
// trailing edge publishes it `delay` ms after the last change), with a
// properly cleaned-up timer (cleared on every dependency change and on
// unmount) so it doesn't reintroduce the leak the global stub was written
// to avoid. Honoring both flags — not just echoing every keystroke — is
// what lets this test actually catch a regression back to
// `{ leading: true, trailing: false }`.
vi.mock("usehooks-ts", async (importActual) => {
	const actual = await importActual<Record<string, unknown>>();
	return {
		...actual,
		useDebounceValue: (
			value: string,
			delay: number,
			options?: { leading?: boolean; trailing?: boolean },
		) => {
			const leading = options?.leading ?? false;
			const trailing = options?.trailing ?? true;
			const [debounced, setDebounced] = useState(value);
			// Tracks whether we're still inside the current burst of changes,
			// so a leading edge only fires once per burst (matching
			// usehooks-ts/lodash.debounce semantics) rather than on every
			// keystroke.
			const burstActive = useRef(false);
			useEffect(() => {
				if (!burstActive.current) {
					burstActive.current = true;
					if (leading) {
						setDebounced(value);
					}
				}
				if (!trailing) {
					// No trailing edge scheduled: `setDebounced(value)` above only
					// runs once per burst, on the leading edge, using whatever
					// `value` was at mount time (i.e. `""`). Because there's no
					// timer here to re-run this effect's leading branch with the
					// latest `value`, the debounced output never advances past
					// that mount-time value — the regression this guards against
					// is "the query never reaches the typed value".
					return;
				}
				const timer = setTimeout(() => {
					setDebounced(value);
					burstActive.current = false;
				}, delay);
				return () => clearTimeout(timer);
			}, [value, delay, leading, trailing]);
			return [debounced, setDebounced] as const;
		},
	};
});

vi.mock("nuqs", () => ({
	parseAsInteger: { withDefault: (d: number) => d },
	parseAsString: { withDefault: (d: string) => d },
	useQueryState: (_key: string, defaultValue: unknown) =>
		useState(defaultValue),
}));

import { UserList } from "@saas/admin/component/users/UserList";

function renderList() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<UserList />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mockListUsers.mockResolvedValue({ users: [], total: 0 });
});

describe("UserList", () => {
	it("requests the first page with API-schema keys", async () => {
		renderList();
		await waitFor(() => {
			expect(mockListUsers).toHaveBeenCalledWith({
				query: undefined,
				limit: 10,
				offset: 0,
			});
		});
	});

	it("sends the FULL debounced search term, not just the first keystroke", async () => {
		renderList();
		const input = screen.getByPlaceholderText("admin.users.search");
		await userEvent.type(input, "Avery");
		await waitFor(() => {
			expect(mockListUsers).toHaveBeenCalledWith(
				expect.objectContaining({ query: "Avery" }),
			);
		});
		// Regression: the old leading-only debounce emitted just "A".
		expect(mockListUsers).not.toHaveBeenCalledWith(
			expect.objectContaining({ query: "A" }),
		);
	});

	it("does not render a stray '0' when a search matches no users", async () => {
		mockListUsers.mockResolvedValue({ users: [], total: 0 });
		renderList();
		const input = screen.getByPlaceholderText("admin.users.search");
		await userEvent.type(input, "nobody");
		await screen.findByText("No results.");
		// Regression: `{data?.total && data.total > ITEMS_PER_PAGE && (...)}`
		// rendered a literal "0" text node when `total` was 0.
		expect(screen.queryByText("0")).toBeNull();
	});
});
