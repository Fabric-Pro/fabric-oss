import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import {
	hashKey,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeatureFlagsPanel } from "../FeatureFlagsPanel";

const setMutate = vi.fn();
const resetMutate = vi.fn();

const flagRow = (over = {}) => ({
	key: "PERSONAL_MEETINGS",
	enabled: false,
	source: "default",
	label: "Personal meetings in Meeting Digest",
	description:
		"Adds the All Meetings filter. Personal transcripts are never stored.",
	envVar: "FABRIC_FEATURE_PERSONAL_MEETINGS",
	default: false,
	note: "Privacy-sensitive (#1899).",
	// The list procedure normalizes this to a boolean for every flag.
	orgScopable: false,
	...over,
});

const defaultListQueryFn = async () => ({ flags: [flagRow()] });

// A flag currently held ON by an explicit override — the only state in which
// the "Reset to default" control is offered.
const overriddenListQueryFn = async () => ({
	flags: [flagRow({ enabled: true, source: "override" })],
});

// `listQueryFn` is swapped per-test (success vs. rejection) so the error
// test doesn't need a second mock module — the query-error test overrides
// it before rendering, and `afterEach` restores the default so later tests
// aren't affected.
let listQueryFn = defaultListQueryFn;

afterEach(() => {
	listQueryFn = defaultListQueryFn;
	toastErrorMock.mockClear();
	setMutate.mockReset();
	resetMutate.mockReset();
});

const { toastErrorMock, LIST_PATH } = vi.hoisted(() => ({
	toastErrorMock: vi.fn(),
	LIST_PATH: ["admin", "featureFlags", "list"],
}));

vi.mock("sonner", () => ({ toast: { error: toastErrorMock } }));

// Stubbed: the disclosure fetches its own enrolment data, and this file's orpc
// mock deliberately models only the three instance-wide procedures. What the
// panel owns is WHETHER the child is mounted, which the stub answers exactly;
// what the child renders has its own test file.
vi.mock("../FlagEnrolmentDisclosure", () => ({
	FlagEnrolmentDisclosure: ({ flagKey }: { flagKey: string }) => (
		<span data-testid="flag-enrolment">{flagKey}</span>
	),
}));

// Mirrors @orpc/tanstack-query's REAL key semantics. The three builders are
// NOT interchangeable:
//
//   queryOptions({ input }).queryKey → [path, { input, type: "query" }]  (full)
//   queryKey({ input })              → [path, { input, type: "query" }]  (full)
//   key()                            → [path, {}]                       (partial)
//
// The partial form exists for `invalidateQueries`, which matches by prefix.
// `setQueryData` hashes EXACTLY, so patching with `key()` writes to a cache
// entry no component subscribes to — silently, since the updater just receives
// `undefined`.
//
// This mock previously returned the same array from `queryOptions().queryKey`
// and `key()`, making the two forms indistinguishable under test. That is what
// let the panel ship patching the wrong key: every assertion below passed while
// the real admin console never updated until a full page reload. Keep them
// distinct. #2138.
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		admin: {
			featureFlags: {
				list: {
					queryOptions: () => ({
						queryKey: [LIST_PATH, { input: {}, type: "query" }],
						queryFn: () => listQueryFn(),
					}),
					queryKey: (options?: { input?: unknown }) => [
						LIST_PATH,
						{ input: options?.input, type: "query" },
					],
					key: () => [LIST_PATH, {}],
				},
				set: {
					mutationOptions: () => ({ mutationFn: setMutate }),
				},
				reset: {
					mutationOptions: () => ({ mutationFn: resetMutate }),
				},
			},
		},
	},
}));

function renderPanel() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<FeatureFlagsPanel />
		</QueryClientProvider>,
	);
}

describe("FeatureFlagsPanel", () => {
	it("lists each registered flag with its label and resolution source", async () => {
		renderPanel();
		expect(
			await screen.findByText("Personal meetings in Meeting Digest"),
		).toBeInTheDocument();
		expect(screen.getByText(/default/i)).toBeInTheDocument();
		expect(
			screen.getByText(/FABRIC_FEATURE_PERSONAL_MEETINGS/),
		).toBeInTheDocument();
	});

	// The disclosure below is what makes the allowlist readable, and it is
	// offered ONLY for a flag the resolver honours per organization —
	// rendering it elsewhere would imply an override level that does not
	// exist there. Both directions, because the interesting failure is it
	// appearing where it should not.
	it("offers no per-organization enrolment for a flag that is not org-scopable", async () => {
		renderPanel();
		await screen.findByText("Personal meetings in Meeting Digest");

		expect(screen.queryByTestId("flag-enrolment")).toBeNull();
	});

	it("offers per-organization enrolment for an org-scopable flag", async () => {
		listQueryFn = async () => ({
			flags: [flagRow({ orgScopable: true })],
		});
		renderPanel();
		await screen.findByText("Personal meetings in Meeting Digest");

		expect(await screen.findByTestId("flag-enrolment")).toBeInTheDocument();
	});

	it("shows the risk note when the registry declares one", async () => {
		renderPanel();
		expect(
			await screen.findByText(/Privacy-sensitive/),
		).toBeInTheDocument();
	});

	it("calls the set mutation when the switch is toggled", async () => {
		setMutate.mockResolvedValue({ success: true, enabled: true });
		renderPanel();

		const toggle = await screen.findByRole("switch", {
			name: /Personal meetings in Meeting Digest/i,
		});
		await userEvent.click(toggle);

		await waitFor(() => {
			// react-query v5's mutation runner invokes `mutationFn(variables,
			// mutationFnContext)` — the second arg is an internal context
			// object (client/meta/mutationKey), not something callers pass.
			// Assert on the first call's first argument rather than
			// `toHaveBeenCalledWith`, which requires an exact argument-list
			// match and would fail here regardless of what the component does.
			expect(setMutate).toHaveBeenCalled();
			expect(setMutate.mock.calls[0][0]).toEqual({
				key: "PERSONAL_MEETINGS",
				enabled: true,
			});
		});
	});

	it("shows an error message and no flag rows when the list query fails", async () => {
		listQueryFn = async () => {
			throw new Error("network down");
		};
		renderPanel();

		expect(
			await screen.findByText(/failed to load feature flags/i),
		).toBeInTheDocument();
		expect(
			screen.queryByText("Personal meetings in Meeting Digest"),
		).not.toBeInTheDocument();
	});

	it("shows an empty-state message when there are no registered flags", async () => {
		listQueryFn = async () => ({ flags: [] });
		renderPanel();

		expect(
			await screen.findByText(/no feature flags registered/i),
		).toBeInTheDocument();
	});

	it("patches the toggled flag from the mutation response without refetching, so the switch does not flap back on a stale-replica read (regression: multi-replica read-after-write)", async () => {
		// A real refetch would re-invoke the list query function. Spying on
		// it lets this test prove no refetch happens — the whole point of
		// patching the cache from the mutation result instead of
		// invalidating. See the `onSuccess` comment in FeatureFlagsPanel.tsx
		// for why: each web replica has an independent 10s flag cache
		// (values-prod.yaml `replicas: 2`), so a refetch right after a write
		// can land on a replica whose cache still has the OLD value, and the
		// switch visibly snaps back with no further refetch scheduled.
		const listQueryFnSpy = vi.fn(defaultListQueryFn);
		listQueryFn = listQueryFnSpy;
		setMutate.mockResolvedValue({ success: true, enabled: true });
		renderPanel();

		const toggle = await screen.findByRole("switch", {
			name: /Personal meetings in Meeting Digest/i,
		});
		expect(toggle).not.toBeChecked();
		expect(screen.getByText(/default/i)).toBeInTheDocument();

		await userEvent.click(toggle);

		await waitFor(() => {
			expect(toggle).toBeChecked();
		});
		expect(await screen.findByText(/Set here/)).toBeInTheDocument();

		// The list query function must have run exactly once — the initial
		// mount fetch. If `onSuccess` invalidated the query instead of
		// patching it, this would be 2.
		expect(listQueryFnSpy).toHaveBeenCalledTimes(1);
	});

	it("surfaces an error toast when the set mutation fails", async () => {
		setMutate.mockRejectedValue(new Error("could not persist flag"));
		renderPanel();

		const toggle = await screen.findByRole("switch", {
			name: /Personal meetings in Meeting Digest/i,
		});
		await userEvent.click(toggle);

		await waitFor(() => {
			expect(toastErrorMock).toHaveBeenCalledWith(
				"Failed to update feature flag",
				expect.objectContaining({
					description: "could not persist flag",
				}),
			);
		});
	});

	it("does NOT offer Reset to default for a flag resolved from env/default", async () => {
		renderPanel(); // default fixture → source "default"
		await screen.findByText("Personal meetings in Meeting Digest");
		expect(
			screen.queryByRole("button", { name: /reset to default/i }),
		).not.toBeInTheDocument();
	});

	it("offers Reset to default only when the source is an explicit override", async () => {
		listQueryFn = overriddenListQueryFn;
		renderPanel();
		expect(
			await screen.findByRole("button", { name: /reset to default/i }),
		).toBeInTheDocument();
	});

	it("calls the reset mutation and patches the row back to its default without refetching", async () => {
		const listQueryFnSpy = vi.fn(overriddenListQueryFn);
		listQueryFn = listQueryFnSpy;
		// Server's authoritative post-clear resolution: back to default/off.
		resetMutate.mockResolvedValue({
			success: true,
			enabled: false,
			source: "default",
		});
		renderPanel();

		const resetBtn = await screen.findByRole("button", {
			name: /reset to default/i,
		});
		// starts as an override that is ON
		expect(screen.getByText(/Set here/)).toBeInTheDocument();
		expect(
			screen.getByRole("switch", {
				name: /Personal meetings in Meeting Digest/i,
			}),
		).toBeChecked();

		await userEvent.click(resetBtn);

		await waitFor(() => {
			expect(resetMutate).toHaveBeenCalled();
			expect(resetMutate.mock.calls[0][0]).toEqual({
				key: "PERSONAL_MEETINGS",
			});
		});

		// Row patched from the mutation result: source back to Default, switch
		// off, and the Reset control gone — all without a refetch.
		expect(await screen.findByText(/default/i)).toBeInTheDocument();
		await waitFor(() => {
			expect(
				screen.queryByRole("button", { name: /reset to default/i }),
			).not.toBeInTheDocument();
		});
		expect(listQueryFnSpy).toHaveBeenCalledTimes(1);
	});

	it("surfaces an error toast when the reset mutation fails", async () => {
		listQueryFn = overriddenListQueryFn;
		resetMutate.mockRejectedValue(new Error("could not clear override"));
		renderPanel();

		const resetBtn = await screen.findByRole("button", {
			name: /reset to default/i,
		});
		await userEvent.click(resetBtn);

		await waitFor(() => {
			expect(toastErrorMock).toHaveBeenCalledWith(
				"Failed to reset feature flag",
				expect.objectContaining({
					description: "could not clear override",
				}),
			);
		});
	});
});

/**
 * Characterization test for @orpc/tanstack-query itself, not for our panel.
 *
 * Every assertion above runs against the module mock, so the mock's idea of how
 * oRPC builds keys is load-bearing: when it wrongly returned one array from
 * both `queryOptions().queryKey` and `key()`, the suite stayed green while the
 * real admin console silently refused to update. These tests pin that
 * assumption to the actual library, so an oRPC upgrade that changes key shape
 * fails here rather than in production. #2138.
 */
describe("@orpc/tanstack-query key semantics (mock fidelity guard)", () => {
	const realOrpc = createTanstackQueryUtils({
		admin: { featureFlags: { list: async () => ({ flags: [] }) } },
	});

	it("builds the same exact key from queryOptions() and queryKey()", () => {
		expect(
			hashKey(realOrpc.admin.featureFlags.list.queryKey({ input: {} })),
		).toBe(
			hashKey(
				realOrpc.admin.featureFlags.list.queryOptions({ input: {} })
					.queryKey,
			),
		);
	});

	it("builds a DIFFERENT, prefix-only key from key() — unusable with setQueryData", () => {
		const exact = realOrpc.admin.featureFlags.list.queryOptions({
			input: {},
		}).queryKey;
		const partial = realOrpc.admin.featureFlags.list.key();

		expect(hashKey(partial)).not.toBe(hashKey(exact));

		// Demonstrates the actual production failure: a setQueryData patch
		// keyed by key() never reaches the entry the component reads, and
		// reports no error while doing nothing.
		const client = new QueryClient();
		client.setQueryData(exact, { flags: [flagRow({ enabled: false })] });

		let updaterSawPrev: unknown = "not called";
		client.setQueryData(partial, (prev: unknown) => {
			updaterSawPrev = prev;
			return prev;
		});

		expect(updaterSawPrev).toBeUndefined();
		expect(client.getQueryData(exact)).toEqual({
			flags: [flagRow({ enabled: false })],
		});
	});
});
