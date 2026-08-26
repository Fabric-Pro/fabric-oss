import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getMyDefault = vi.fn();
const setMyDefault = vi.fn();
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		functionTags: {
			getMyDefault: {
				queryOptions: () => ({
					queryKey: ["ft", "getMyDefault"],
					queryFn: getMyDefault,
				}),
				queryKey: () => ["ft", "getMyDefault"],
			},
		},
	},
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		functionTags: { setMyDefault: (i: unknown) => setMyDefault(i) },
	},
}));

let flagValue = false;
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => flagValue,
}));

import { DefaultFunctionTagsForm } from "../DefaultFunctionTagsForm";

function makeClient() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
}

function wrap(ui: React.ReactElement, client = makeClient()) {
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

describe("DefaultFunctionTagsForm", () => {
	beforeEach(() => {
		// Reset call history (not just implementations) between tests — several
		// tests assert `setMyDefault`/`getMyDefault` were or weren't called, and
		// without a reset, call counts leak across tests in this file.
		getMyDefault.mockReset();
		setMyDefault.mockReset();
		getMyDefault.mockResolvedValue({ tags: ["DEVELOPER"] });
		setMyDefault.mockResolvedValue({ tags: ["DEVELOPER", "ARCHITECT"] });
		// Reset between tests so these two cases cannot leak into the file's
		// other tests.
		flagValue = false;
	});

	it("loads and shows the current default as a chip", async () => {
		wrap(<DefaultFunctionTagsForm />);
		expect(await screen.findByText("Developer")).toBeInTheDocument();
	});

	it("saves the edited set via setMyDefault", async () => {
		wrap(<DefaultFunctionTagsForm />);
		await screen.findByText("Developer");
		fireEvent.click(screen.getByLabelText("Your default function tags"));
		fireEvent.click(screen.getByText("Architect"));
		fireEvent.click(screen.getByRole("button", { name: /save/i }));
		await waitFor(() =>
			expect(setMyDefault).toHaveBeenCalledWith({
				tags: ["DEVELOPER", "ARCHITECT"],
			}),
		);
	});

	it("keeps Save and the picker disabled until defaults load, and Save disabled when unchanged", async () => {
		// Hold the initial load open so we can observe the pre-load state.
		let resolveLoad!: (v: { tags: string[] }) => void;
		getMyDefault.mockReturnValue(
			new Promise<{ tags: string[] }>((resolve) => {
				resolveLoad = resolve;
			}),
		);

		wrap(<DefaultFunctionTagsForm />);

		// Before the current defaults arrive: no submit (would persist empty),
		// no editing.
		expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
		expect(
			screen.getByLabelText("Your default function tags"),
		).toBeDisabled();

		// Resolve the load — controls enable, but Save stays disabled because
		// the selection still equals the saved set (dirty-check).
		resolveLoad({ tags: ["DEVELOPER"] });
		await screen.findByText("Developer");
		expect(
			screen.getByLabelText("Your default function tags"),
		).not.toBeDisabled();
		expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
	});

	it("keeps Save and the picker disabled when getMyDefault REJECTS (React Query v5: isLoading goes false on error too)", async () => {
		// A terminal error, not a pending state. `isLoading` is
		// `isPending && isFetching` in React Query v5, so it's already
		// `false` once this query errors — a gate written as
		// `controlsDisabled = isLoading || save.isPending` would have
		// re-enabled the picker and Save here even though `data` never
		// arrived, letting a Save persist the empty starting `value` over
		// the user's real defaults. The fix gates on `!isSuccess`, which
		// stays true on the error path.
		//
		// Both the old buggy gate and the fixed one are ALSO true during the
		// initial pending phase (isLoading / !isSuccess are both true before
		// the query settles), so asserting immediately after mount would
		// pass either way and not actually exercise the regression. Force
		// the query to genuinely settle to its terminal `error` status
		// first, via the QueryClient's own cache state, before asserting.
		getMyDefault.mockRejectedValue(new Error("network down"));
		const client = makeClient();

		wrap(<DefaultFunctionTagsForm />, client);

		await waitFor(() =>
			expect(client.getQueryState(["ft", "getMyDefault"])?.status).toBe(
				"error",
			),
		);

		expect(
			screen.getByLabelText("Your default function tags"),
		).toBeDisabled();
		expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
		expect(setMyDefault).not.toHaveBeenCalled();
	});

	it("invalidates the getMyDefault query cache on successful save", async () => {
		const client = makeClient();
		const invalidateSpy = vi.spyOn(client, "invalidateQueries");

		wrap(<DefaultFunctionTagsForm />, client);
		await screen.findByText("Developer");
		fireEvent.click(screen.getByLabelText("Your default function tags"));
		fireEvent.click(screen.getByText("Architect"));
		fireEvent.click(screen.getByRole("button", { name: /save/i }));

		await waitFor(() =>
			expect(invalidateSpy).toHaveBeenCalledWith({
				queryKey: ["ft", "getMyDefault"],
			}),
		);
	});

	it("blocks saving an empty selection when enforcement is on", async () => {
		flagValue = true;
		getMyDefault.mockResolvedValue({
			tags: ["DEVELOPER"],
			enforcementEnabled: true,
		});
		wrap(<DefaultFunctionTagsForm />);

		const remove = await screen.findByRole("button", {
			name: "Remove Developer",
		});
		fireEvent.click(remove);

		expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
		expect(
			screen.getByText(/at least one role is required/i),
		).toBeInTheDocument();
	});

	it("still allows clearing when enforcement is off", async () => {
		flagValue = false;
		getMyDefault.mockResolvedValue({
			tags: ["DEVELOPER"],
			enforcementEnabled: false,
		});
		wrap(<DefaultFunctionTagsForm />);

		const remove = await screen.findByRole("button", {
			name: "Remove Developer",
		});
		fireEvent.click(remove);

		expect(screen.getByRole("button", { name: /save/i })).toBeEnabled();
		expect(
			screen.queryByText(/at least one role is required/i),
		).not.toBeInTheDocument();
	});

	it("still allows clearing when the payload flag is off, even if the live enforcementEnabled is true", async () => {
		// The missing direction: `flagValue` (the frozen RSC-payload flag) OFF
		// while the live `enforcementEnabled` is TRUE. No floor should apply —
		// the payload flag being off is the global kill switch, and it must
		// win regardless of the live field, matching `shouldEnforce`'s "flag
		// off wins over everything" rule. Every other test in this file
		// leaves the `useFeatureFlag("ROLE_TAG_ENFORCEMENT") &&` conjunct free
		// to be deleted without going red; this is the one that pins it.
		flagValue = false;
		getMyDefault.mockResolvedValue({
			tags: ["DEVELOPER"],
			enforcementEnabled: true,
		});
		wrap(<DefaultFunctionTagsForm />);

		const remove = await screen.findByRole("button", {
			name: "Remove Developer",
		});
		fireEvent.click(remove);

		expect(screen.getByRole("button", { name: /save/i })).toBeEnabled();
		expect(
			screen.queryByText(/at least one role is required/i),
		).not.toBeInTheDocument();
	});

	it("does not flash the required-role note while the initial load is still pending, even with enforcement on", async () => {
		// Before `getMyDefault` resolves, `value` is still its empty initial
		// state — indistinguishable from "the user cleared their tags" unless
		// the floor also checks that the read actually succeeded. Without
		// that check, EVERY visitor sees this note for a frame while the
		// flag is on, tagged or not.
		flagValue = true;
		let resolveLoad!: (v: {
			tags: string[];
			enforcementEnabled: boolean;
		}) => void;
		getMyDefault.mockReturnValue(
			new Promise<{ tags: string[]; enforcementEnabled: boolean }>(
				(resolve) => {
					resolveLoad = resolve;
				},
			),
		);

		wrap(<DefaultFunctionTagsForm />);

		expect(
			screen.queryByText(/at least one role is required/i),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();

		resolveLoad({ tags: ["DEVELOPER"], enforcementEnabled: true });
		await screen.findByText("Developer");
	});

	it("re-enables saving an empty selection when the live enforcementEnabled flag is false, even with the kill-switch flag on", async () => {
		// The kill-switch flag (`flagValue`) is the frozen RSC-payload read;
		// `enforcementEnabled` on `getMyDefault`'s response is the live
		// re-read of the same flag. An admin can withdraw enforcement after
		// this page's payload was generated — this form must follow the live
		// value, not just the payload snapshot, or the kill switch closes
		// everywhere except the one screen a user would act on.
		flagValue = true;
		getMyDefault.mockResolvedValue({
			tags: ["DEVELOPER"],
			enforcementEnabled: false,
		});
		wrap(<DefaultFunctionTagsForm />);

		const remove = await screen.findByRole("button", {
			name: "Remove Developer",
		});
		fireEvent.click(remove);

		expect(screen.getByRole("button", { name: /save/i })).toBeEnabled();
		expect(
			screen.queryByText(/at least one role is required/i),
		).not.toBeInTheDocument();
	});
});
