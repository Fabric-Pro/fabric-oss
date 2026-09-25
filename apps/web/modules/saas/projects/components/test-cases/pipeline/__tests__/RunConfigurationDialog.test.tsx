/**
 * Fizzy #2233 — the run-configuration dialog shows a real figure before an
 * Agentic run spends anything, requires an explicit confirmation step for it,
 * dispatches Scripted directly (it costs nothing), and refuses to default to
 * the billed runner every time the dialog opens.
 *
 * next-intl is globally key-mocked in vitest.setup.ts, so translated strings
 * surface as their keys ("confirmTitle", "start", …) and interpolation
 * values are dropped — assertions below match on the KEY, not the rendered
 * sentence.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

type QueryTag = "configurations" | "environments" | "quote";

let configurationsData: unknown[] = [];
let environmentsData: unknown[] = [];
let quoteData: unknown;
let quoteIsLoading = false;

const useQueryMock = vi.fn((options?: { __query?: QueryTag }) => {
	if (options?.__query === "configurations") {
		return { data: configurationsData, isLoading: false };
	}
	if (options?.__query === "environments") {
		return { data: environmentsData, isLoading: false };
	}
	if (options?.__query === "quote") {
		return { data: quoteData, isLoading: quoteIsLoading };
	}
	return { data: undefined, isLoading: false };
});

const saveMutate = vi.fn();
/** A sentinel distinct from any real input value — the dialog never inspects
 * it (`useQuery` is fully mocked here), only passes it through. */
const SKIP_TOKEN = Symbol("skipToken");

vi.mock("@tanstack/react-query", () => ({
	useQuery: (options: unknown) => useQueryMock(options as never),
	// The dialog itself only ever calls `useMutation` once, for "Save as a
	// configuration" — dispatching a run is the `onDispatch` prop, driven
	// by the PARENT's own mutation, so there is nothing else to branch on
	// here.
	useMutation: () => ({ mutate: saveMutate, isPending: false }),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
	skipToken: SKIP_TOKEN,
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			agenticRuns: {
				configurations: {
					list: {
						queryOptions: (o: unknown) => ({
							...(o as object),
							__query: "configurations",
						}),
						key: () => ["runConfigurations"],
					},
					create: {
						mutationOptions: (o: unknown) => ({
							...(o as object),
							__mutation: "save",
						}),
					},
				},
				quote: {
					queryOptions: (o: unknown) => ({
						...(o as object),
						__query: "quote",
					}),
				},
			},
			environments: {
				list: {
					queryOptions: (o: unknown) => ({
						...(o as object),
						__query: "environments",
					}),
				},
			},
		},
	},
}));

const { RunConfigurationDialog } = await import("../RunConfigurationDialog");

const SYSTEM_CONFIG = {
	id: "cfg-system",
	name: "Project defaults",
	isSystem: true,
	environmentId: null,
	browser: null,
	resolution: null,
	runMode: "MODE_A" as const,
};

function quote(overrides: {
	resolvedCaseCount: number;
	agenticRunnable: number;
	stepCount: number;
	estimatedCostUsd: number;
	capUsd: number;
	withinCap: boolean;
	scriptedRunnable: number;
	/** Defaults true — most tests are not about the permission gate. */
	scriptedPermitted?: boolean;
}) {
	return {
		resolvedCaseCount: overrides.resolvedCaseCount,
		agentic: {
			runnableCaseCount: overrides.agenticRunnable,
			stepCount: overrides.stepCount,
			estimatedCostUsd: overrides.estimatedCostUsd,
			capUsd: overrides.capUsd,
			withinCap: overrides.withinCap,
		},
		scripted: {
			runnableCaseCount: overrides.scriptedRunnable,
			permitted: overrides.scriptedPermitted ?? true,
		},
	};
}

function renderDialog(
	props: Partial<React.ComponentProps<typeof RunConfigurationDialog>> = {},
) {
	return render(
		<RunConfigurationDialog
			projectId="p1"
			open={true}
			onOpenChange={() => undefined}
			caseCount={2}
			selection={{ mode: "ids", ids: ["c1", "c2"] }}
			dispatching={false}
			onDispatch={() => undefined}
			{...props}
		/>,
	);
}

const localStorageStore = new Map<string, string>();

beforeEach(() => {
	vi.clearAllMocks();
	localStorageStore.clear();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => localStorageStore.get(key) ?? null,
		setItem: (key: string, value: string) => {
			localStorageStore.set(key, value);
		},
		removeItem: (key: string) => localStorageStore.delete(key),
		clear: () => localStorageStore.clear(),
	});
	configurationsData = [SYSTEM_CONFIG];
	environmentsData = [];
	quoteData = undefined;
	quoteIsLoading = false;
});

describe("RunConfigurationDialog — the pre-dispatch figure", () => {
	it("shows the loading state while the quote is in flight", () => {
		quoteIsLoading = true;
		renderDialog();

		expect(screen.getByText("estimating")).toBeInTheDocument();
	});

	it("shows the Agentic figure once the quote answers", () => {
		quoteData = quote({
			resolvedCaseCount: 2,
			agenticRunnable: 2,
			stepCount: 6,
			estimatedCostUsd: 0.3,
			capUsd: 5,
			withinCap: true,
			scriptedRunnable: 0,
		});
		renderDialog();

		expect(screen.getByText("estimateAgentic")).toBeInTheDocument();
	});

	it("says the estimate is unavailable, without blocking Start, when the quote fails to load", () => {
		quoteData = undefined;
		quoteIsLoading = false;
		renderDialog();

		expect(screen.getByText("estimateUnavailable")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "start" })).toBeEnabled();
	});

	it("disables Start and shows the refusal sentence over the cap", () => {
		quoteData = quote({
			resolvedCaseCount: 2,
			agenticRunnable: 2,
			stepCount: 400,
			estimatedCostUsd: 20,
			capUsd: 5,
			withinCap: false,
			scriptedRunnable: 0,
		});
		renderDialog();

		expect(screen.getByText("overCapWarning")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "start" })).toBeDisabled();
	});

	it("shows the scripted line, not an Agentic figure, once Scripted is selected", async () => {
		quoteData = quote({
			resolvedCaseCount: 2,
			agenticRunnable: 2,
			stepCount: 6,
			estimatedCostUsd: 0.3,
			capUsd: 5,
			withinCap: true,
			scriptedRunnable: 2,
		});
		const user = userEvent.setup();
		renderDialog();

		await user.click(screen.getByRole("combobox", { name: "runner" }));
		await user.click(
			screen.getByRole("option", { name: /runnerScripted/ }),
		);

		expect(screen.getByText("estimateScripted")).toBeInTheDocument();
	});
});

describe("RunConfigurationDialog — confirmation before a billed run", () => {
	it("moves Agentic's Start to a confirm step instead of dispatching directly", async () => {
		quoteData = quote({
			resolvedCaseCount: 2,
			agenticRunnable: 2,
			stepCount: 6,
			estimatedCostUsd: 0.3,
			capUsd: 5,
			withinCap: true,
			scriptedRunnable: 0,
		});
		const onDispatch = vi.fn();
		const user = userEvent.setup();
		renderDialog({ onDispatch });

		await user.click(screen.getByRole("button", { name: "start" }));

		expect(screen.getByText("confirmTitle")).toBeInTheDocument();
		expect(onDispatch).not.toHaveBeenCalled();
		expect(
			screen.getByRole("button", { name: "confirmAndStart" }),
		).toBeInTheDocument();
	});

	it("dispatches once 'Confirm and start' is pressed", async () => {
		quoteData = quote({
			resolvedCaseCount: 2,
			agenticRunnable: 2,
			stepCount: 6,
			estimatedCostUsd: 0.3,
			capUsd: 5,
			withinCap: true,
			scriptedRunnable: 0,
		});
		const onDispatch = vi.fn();
		const user = userEvent.setup();
		renderDialog({ onDispatch });

		await user.click(screen.getByRole("button", { name: "start" }));
		await user.click(
			screen.getByRole("button", { name: "confirmAndStart" }),
		);

		expect(onDispatch).toHaveBeenCalledWith(
			expect.objectContaining({ runMode: "MODE_A" }),
		);
	});

	it("Back returns to the configuration step without dispatching", async () => {
		quoteData = quote({
			resolvedCaseCount: 2,
			agenticRunnable: 2,
			stepCount: 6,
			estimatedCostUsd: 0.3,
			capUsd: 5,
			withinCap: true,
			scriptedRunnable: 0,
		});
		const onDispatch = vi.fn();
		const user = userEvent.setup();
		renderDialog({ onDispatch });

		await user.click(screen.getByRole("button", { name: "start" }));
		await user.click(screen.getByRole("button", { name: "back" }));

		expect(screen.getByText("title")).toBeInTheDocument();
		expect(onDispatch).not.toHaveBeenCalled();
	});

	it("dispatches Scripted directly — no confirm step for a free run", async () => {
		configurationsData = [{ ...SYSTEM_CONFIG, runMode: "MODE_B" }];
		quoteData = quote({
			resolvedCaseCount: 2,
			agenticRunnable: 0,
			stepCount: 0,
			estimatedCostUsd: 0,
			capUsd: 5,
			withinCap: true,
			scriptedRunnable: 2,
		});
		const onDispatch = vi.fn();
		const user = userEvent.setup();
		renderDialog({ onDispatch });

		await waitFor(() =>
			expect(
				screen.getByRole("combobox", { name: "runner" }),
			).toHaveTextContent("runnerScripted"),
		);
		await user.click(screen.getByRole("button", { name: "start" }));

		expect(onDispatch).toHaveBeenCalledWith(
			expect.objectContaining({ runMode: "MODE_B" }),
		);
		expect(screen.queryByText("confirmTitle")).not.toBeInTheDocument();
	});
});

describe("RunConfigurationDialog — default runner selection", () => {
	it("defaults to Agentic when the selection has no saved scripts and nothing is remembered", async () => {
		quoteData = quote({
			resolvedCaseCount: 2,
			agenticRunnable: 2,
			stepCount: 6,
			estimatedCostUsd: 0.3,
			capUsd: 5,
			withinCap: true,
			scriptedRunnable: 0,
		});
		renderDialog();

		await waitFor(() =>
			expect(
				screen.getByRole("combobox", { name: "runner" }),
			).toHaveTextContent("runnerAgentic"),
		);
	});

	it("defaults to Scripted when every selected case has a saved script", async () => {
		quoteData = quote({
			resolvedCaseCount: 2,
			agenticRunnable: 2,
			stepCount: 6,
			estimatedCostUsd: 0.3,
			capUsd: 5,
			withinCap: true,
			scriptedRunnable: 2,
		});
		renderDialog();

		await waitFor(() =>
			expect(
				screen.getByRole("combobox", { name: "runner" }),
			).toHaveTextContent("runnerScripted"),
		);
	});

	it("uses the viewer's remembered runner over the scripted-aware default", async () => {
		localStorageStore.set(
			"fabric.qa.run-configuration.runner.p1",
			"MODE_A",
		);
		// Every case has a script, which would otherwise default to Scripted —
		// the remembered choice must win.
		quoteData = quote({
			resolvedCaseCount: 2,
			agenticRunnable: 2,
			stepCount: 6,
			estimatedCostUsd: 0.3,
			capUsd: 5,
			withinCap: true,
			scriptedRunnable: 2,
		});
		renderDialog();

		await waitFor(() =>
			expect(
				screen.getByRole("combobox", { name: "runner" }),
			).toHaveTextContent("runnerAgentic"),
		);
	});

	it("keeps an explicitly saved (non-system) configuration's own runMode", () => {
		configurationsData = [
			{
				id: "cfg-saved",
				name: "Nightly on Firefox",
				isSystem: false,
				environmentId: null,
				browser: "firefox",
				resolution: null,
				runMode: "MODE_A",
			},
		];
		quoteData = quote({
			resolvedCaseCount: 2,
			agenticRunnable: 2,
			stepCount: 6,
			estimatedCostUsd: 0.3,
			capUsd: 5,
			withinCap: true,
			scriptedRunnable: 2,
		});
		renderDialog();

		// A non-system configuration's runMode is never overridden by the
		// scripted-aware default, even when every case has a script.
		expect(
			screen.getByRole("combobox", { name: "runner" }),
		).toHaveTextContent("runnerAgentic");
	});

	it("remembers the runner once Start (Scripted) is pressed", async () => {
		configurationsData = [{ ...SYSTEM_CONFIG, runMode: "MODE_B" }];
		quoteData = quote({
			resolvedCaseCount: 2,
			agenticRunnable: 0,
			stepCount: 0,
			estimatedCostUsd: 0,
			capUsd: 5,
			withinCap: true,
			scriptedRunnable: 2,
		});
		const user = userEvent.setup();
		renderDialog();

		await waitFor(() =>
			expect(
				screen.getByRole("combobox", { name: "runner" }),
			).toHaveTextContent("runnerScripted"),
		);
		await user.click(screen.getByRole("button", { name: "start" }));

		expect(
			localStorageStore.get("fabric.qa.run-configuration.runner.p1"),
		).toBe("MODE_B");
	});
});

describe("RunConfigurationDialog — the scripted permission gate", () => {
	it("stays Agentic when every case has a script but the viewer is not permitted", async () => {
		quoteData = quote({
			resolvedCaseCount: 2,
			agenticRunnable: 2,
			stepCount: 6,
			estimatedCostUsd: 0.3,
			capUsd: 5,
			withinCap: true,
			scriptedRunnable: 2,
			scriptedPermitted: false,
		});
		renderDialog();

		// The scripted-aware default never fires without permission — the
		// dialog stays on the safe default every EDITOR may actually start.
		await waitFor(() =>
			expect(
				screen.getByRole("combobox", { name: "runner" }),
			).toHaveTextContent("runnerAgentic"),
		);
	});

	it("never restores a remembered Scripted runner the viewer is no longer permitted to use", async () => {
		localStorageStore.set(
			"fabric.qa.run-configuration.runner.p1",
			"MODE_B",
		);
		quoteData = quote({
			resolvedCaseCount: 2,
			agenticRunnable: 2,
			stepCount: 6,
			estimatedCostUsd: 0.3,
			capUsd: 5,
			withinCap: true,
			scriptedRunnable: 2,
			scriptedPermitted: false,
		});
		renderDialog();

		await waitFor(() =>
			expect(
				screen.getByRole("combobox", { name: "runner" }),
			).toHaveTextContent("runnerAgentic"),
		);
	});

	it("disables the Scripted option in the picker, with a short reason, when not permitted", async () => {
		quoteData = quote({
			resolvedCaseCount: 2,
			agenticRunnable: 2,
			stepCount: 6,
			estimatedCostUsd: 0.3,
			capUsd: 5,
			withinCap: true,
			scriptedRunnable: 2,
			scriptedPermitted: false,
		});
		const user = userEvent.setup();
		renderDialog();

		await waitFor(() =>
			expect(
				screen.getByRole("combobox", { name: "runner" }),
			).toBeInTheDocument(),
		);
		await user.click(screen.getByRole("combobox", { name: "runner" }));
		const scriptedOption = screen.getByRole("option", {
			name: /runnerScripted/,
		});

		expect(scriptedOption).toHaveAttribute("aria-disabled", "true");
		expect(scriptedOption).toHaveTextContent("scriptedNotPermittedShort");
	});

	it("disables Start and explains why when a saved (non-system) configuration carries a Scripted mode the viewer cannot run", () => {
		// A saved configuration keeps its own runMode regardless of who
		// applies it — this is the case the SelectItem's own disabled state
		// cannot prevent, since the dialog never asked here, it inherited it.
		configurationsData = [
			{
				id: "cfg-saved",
				name: "Nightly scripted",
				isSystem: false,
				environmentId: null,
				browser: null,
				resolution: null,
				runMode: "MODE_B",
			},
		];
		quoteData = quote({
			resolvedCaseCount: 2,
			agenticRunnable: 0,
			stepCount: 0,
			estimatedCostUsd: 0,
			capUsd: 5,
			withinCap: true,
			scriptedRunnable: 2,
			scriptedPermitted: false,
		});
		renderDialog();

		expect(
			screen.getByText("scriptedNotPermittedWarning"),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "start" })).toBeDisabled();
	});
});
