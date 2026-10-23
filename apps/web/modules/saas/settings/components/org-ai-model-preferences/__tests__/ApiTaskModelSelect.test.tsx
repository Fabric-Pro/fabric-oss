import en from "@repo/i18n/translations/en.json";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () => vi.importActual("next-intl"));
vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: {} }));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: vi.fn(),
}));

import { API_DEFAULT_VALUE, ApiTaskModelSelect } from "../ApiTaskModelSelect";
import {
	type ApiTaskView,
	DECISION_DISABLED_VALUE,
} from "../use-org-api-model-preferences";

const model = (name: string, id: string, canonicalName = id) => ({
	id,
	canonicalName,
	displayName: name,
	providerModelId: id,
	family: "example",
	vendor: "Example",
	speedTier: "FAST",
	qualityTier: "PREMIUM",
	capabilities: ["TEXT"],
});
const models = [
	model("Example current", "openai/example-current"),
	model(
		"Example second",
		"openai/example-second",
		"example-canonical-second",
	),
	model("Example Claude", "anthropic/example-claude"),
	model("Example Atlas", "anthropic/example-atlas"),
	model("Example unknown", "example-maker/example-model"),
];
function view(
	gateway = "VERCEL_GATEWAY",
	overrides: Partial<ApiTaskView> = {},
): ApiTaskView {
	return {
		taskType: "COMPLEX",
		readOnly: false,
		currentValue: `${gateway}:${models[0].canonicalName}`,
		currentModel: models[0],
		currentGateway: gateway,
		defaultModel: models[1],
		hasCustomPref: true,
		hasPendingChange: false,
		isDisabledChoice: false,
		offersDisabledChoice: false,
		hasModels: true,
		hierarchicalModels: [
			{
				gateway,
				gatewayDisplayName: gateway,
				isDefault: true,
				providers: [
					{
						provider: "catalog",
						providerDisplayName:
							gateway === "ANTHROPIC_DIRECT"
								? "Anthropic"
								: "Example",
						models:
							gateway === "ANTHROPIC_DIRECT"
								? [model("Example Claude", "claude-example")]
								: models,
					},
				],
			},
		],
		...overrides,
	};
}
function setup(
	props: Partial<React.ComponentProps<typeof ApiTaskModelSelect>> = {},
) {
	const onValueChange = vi.fn();
	render(
		<NextIntlClientProvider locale="en" messages={en}>
			<ApiTaskModelSelect
				view={view()}
				disabled={false}
				hasNoProviders={false}
				onValueChange={onValueChange}
				ariaLabel="Complex work on API billing"
				{...props}
			/>
		</NextIntlClientProvider>,
	);
	return { onValueChange, user: userEvent.setup() };
}
async function open(user: ReturnType<typeof userEvent.setup>) {
	const trigger = screen.getByRole("button", {
		name: /^Complex work on API billing/,
	});
	await user.click(trigger);
	return {
		trigger,
		input: screen.getByRole("combobox", { name: "Search models" }),
	};
}

describe("searchable API task picker", () => {
	// Replacing the CommandInput/filter with the previous Select must fail this search.
	it("filters names and provider model ids and reports an empty search", async () => {
		const { user } = setup();
		const { input } = await open(user);
		await user.type(input, "Example Claude");
		expect(
			screen.getByRole("option", { name: /Example Claude/ }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("option", { name: /Example second/ }),
		).toBeNull();
		await user.clear(input);
		await user.type(input, "openai/example-second");
		expect(
			screen.getByRole("option", { name: /^Example second Fast/ }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("option", {
				name: "Example second (default)",
			}),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("option", { name: /Example Claude/ }),
		).toBeNull();
		await user.clear(input);
		await user.type(input, "no-such-model");
		expect(
			screen.getByText("No models match no-such-model"),
		).toBeInTheDocument();
	});
	// Removing maker grouping/filtering must expose the other makers' catalog entries.
	it("groups gateway models by prefix and filters with counted keyboard-reachable chips", async () => {
		const { user } = setup();
		await open(user);
		expect(
			screen.getByRole("button", { name: "OpenAI (2)" }),
		).toHaveAttribute("aria-pressed", "false");
		const anthropic = screen.getByRole("button", { name: "Anthropic (2)" });
		expect(screen.getByRole("listbox")).not.toContainElement(anthropic);
		expect(
			screen.getByRole("button", { name: "Example Maker (1)" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("group", { name: "Anthropic" }),
		).toHaveTextContent("Example Claude");
		await user.click(anthropic);
		expect(anthropic).toHaveAttribute("aria-pressed", "true");
		expect(screen.queryByRole("group", { name: "OpenAI" })).toBeNull();
		expect(
			screen.queryByRole("option", { name: /^Example second Fast/ }),
		).toBeNull();
		expect(
			within(screen.getByRole("group", { name: "Anthropic" }))
				.getAllByRole("option")
				.map((item) => item.textContent),
		).toEqual([
			expect.stringContaining("Example Claude"),
			expect.stringContaining("Example Atlas"),
		]);
		anthropic.focus();
		await user.keyboard("{Enter}");
		expect(anthropic).toHaveAttribute("aria-pressed", "false");
		expect(
			screen.getByRole("option", { name: /^Example second Fast/ }),
		).toBeInTheDocument();
	});
	// Ignoring the shared gateway set would miss OpenRouter's maker chips.
	it("also offers maker filters for OpenRouter", async () => {
		const { user } = setup({ view: view("OPENROUTER") });
		await open(user);
		expect(
			screen.getByRole("button", { name: "Anthropic (2)" }),
		).toBeInTheDocument();
	});
	// Replacing the reset sentinel with a catalog model value breaks the callback contract.
	it("pins Current and a named system default that uses the reset callback", async () => {
		const { user, onValueChange } = setup();
		await open(user);
		const current = screen.getByRole("option", {
			name: /^Example current/,
		});
		expect(current).toHaveTextContent("Current");
		expect(
			within(current).getByRole("img", { name: "Selected model" }),
		).toBeInTheDocument();
		await user.click(
			screen.getByRole("option", {
				name: "Example second (default)",
			}),
		);
		expect(onValueChange).toHaveBeenCalledWith(API_DEFAULT_VALUE);
		expect(screen.queryByRole("listbox")).toBeNull();
	});
	// Showing the long Select or unconditional maker controls fails the direct-provider layout.
	it("shows search without chips or headings for a direct single-maker provider", async () => {
		const { user } = setup({
			view: view("ANTHROPIC_DIRECT", {
				currentModel: null,
				currentValue: "",
				defaultModel: null,
			}),
		});
		await open(user);
		expect(screen.queryByRole("button", { name: "All" })).toBeNull();
		expect(screen.queryByRole("group", { name: "Anthropic" })).toBeNull();
		expect(
			screen.getByRole("option", { name: /Example Claude/ }),
		).toBeInTheDocument();
	});
	// Removing Command's keyboard navigation or the close-on-select behavior breaks selection/focus.
	it("supports arrow navigation, Enter selection, and Escape returning focus", async () => {
		const { user, onValueChange } = setup();
		const { trigger, input } = await open(user);
		await user.type(input, "anthropic/");
		await user.keyboard("{ArrowDown}{Enter}");
		expect(onValueChange).toHaveBeenCalledWith(
			"VERCEL_GATEWAY:anthropic/example-atlas",
		);
		await waitFor(() => expect(trigger).toHaveFocus());
		await user.click(trigger);
		expect(
			screen.getByRole("combobox", { name: "Search models" }),
		).toHaveValue("");
		await user.keyboard("{Escape}");
		await waitFor(() => expect(trigger).toHaveFocus());
		expect(screen.queryByRole("listbox")).toBeNull();
	});
	// Returning an interactive trigger for disabled/read-only callers fails this member boundary.
	it("renders a member's choice as text without a trigger", () => {
		setup({
			disabled: true,
			view: view("VERCEL_GATEWAY", { readOnly: true }),
		});
		expect(screen.getByText("Example current")).toBeInTheDocument();
		expect(screen.queryByText("via Vercel AI Gateway")).toBeNull();
		expect(screen.queryByRole("button")).toBeNull();
		expect(screen.queryByRole("combobox")).toBeNull();
	});
	// Removing the disabled item/sentinel changes the decision off-switch contract.
	it("keeps the pinned decision Disabled choice", async () => {
		const { user, onValueChange } = setup({
			view: view("VERCEL_GATEWAY", { offersDisabledChoice: true }),
		});
		await open(user);
		await user.click(screen.getByRole("option", { name: /Disabled/ }));
		expect(onValueChange).toHaveBeenCalledWith(DECISION_DISABLED_VALUE);
	});
	// Dropping the existing vector-size restriction makes an unavailable catalog item selectable.
	it("keeps unavailable models disabled and gives capability icons text labels", async () => {
		const { user, onValueChange } = setup({
			modelUnavailableReason: (name) =>
				name === models[2].canonicalName
					? "Example model unavailable"
					: undefined,
		});
		await open(user);
		const item = screen.getByRole("option", { name: /Example Claude/ });
		expect(item).toHaveAttribute("aria-disabled", "true");
		expect(item).toHaveTextContent("Example model unavailable");
		expect(
			within(item).getByRole("img", { name: "Fast model" }),
		).toBeInTheDocument();
		expect(
			within(item).getByRole("img", { name: "Premium quality" }),
		).toBeInTheDocument();
		fireEvent.click(item);
		expect(onValueChange).not.toHaveBeenCalled();
	});
});

// Removing the Audio exception changes its existing Select control and value contract.
it("retains the Audio Select without a search input", async () => {
	const { user, onValueChange } = setup({
		view: view("VERCEL_GATEWAY", { taskType: "AUDIO" }),
	});
	await user.click(
		screen.getByRole("combobox", { name: /^Complex work on API billing/ }),
	);
	expect(
		screen.queryByRole("combobox", { name: "Search models" }),
	).toBeNull();
	await user.click(screen.getByRole("option", { name: /Example second/ }));
	expect(onValueChange).toHaveBeenCalledWith(
		`VERCEL_GATEWAY:${models[1].canonicalName}`,
	);
});

it("marks a pending pick Unsaved and declares the trigger popup role", async () => {
	const { user } = setup({
		view: view("VERCEL_GATEWAY", { hasPendingChange: true }),
	});
	const { trigger } = await open(user);
	expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
	const item = screen.getByRole("option", { name: /^Example current/ });
	expect(item).toHaveTextContent("Unsaved");
	expect(item).not.toHaveTextContent("Current");
});

it("focuses search on open without scrolling, including cmdk keyboard selection", async () => {
	const focus = vi.spyOn(HTMLElement.prototype, "focus");
	try {
		const { user } = setup();
		const { input } = await open(user);
		await waitFor(() => expect(input).toHaveFocus());
		const callsForInput = () =>
			focus.mock.calls.filter(
				(_, index) => focus.mock.instances[index] === input,
			);
		expect(callsForInput().length).toBeGreaterThan(0);
		expect(
			callsForInput().every(
				([options]) => options?.preventScroll === true,
			),
		).toBe(true);
		focus.mockClear();
		await user.keyboard("{ArrowDown}{ArrowDown}");
		expect(input).toHaveFocus();
		expect(callsForInput().length).toBeGreaterThan(0);
		expect(
			callsForInput().every(
				([options]) => options?.preventScroll === true,
			),
		).toBe(true);
	} finally {
		focus.mockRestore();
	}
});

it("scrolls cmdk selection only inside the model catalog", async () => {
	const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
	try {
		const { user } = setup();
		await open(user);
		const item = screen.getByRole("option", { name: /Example unknown/ });
		const catalog = item.closest<HTMLElement>("[data-model-catalog]");
		expect(catalog).not.toBeNull();
		if (!catalog) {
			throw new Error("Missing model catalog");
		}
		vi.spyOn(catalog, "getBoundingClientRect").mockReturnValue({
			top: 0,
			bottom: 100,
		} as DOMRect);
		vi.spyOn(item, "getBoundingClientRect").mockReturnValue({
			top: 150,
			bottom: 180,
		} as DOMRect);
		scroll.mockClear();
		await user.keyboard("{End}");
		await waitFor(() => expect(catalog.scrollTop).toBe(80));
		expect(scroll).not.toHaveBeenCalled();
	} finally {
		scroll.mockRestore();
	}
});

// A missing default is explained by the shared bar, including for members.
it.each([false, true])(
	"uses a quiet placeholder with no default provider (readOnly=%s)",
	(readOnly) => {
		setup({
			view: view("OPENAI_DIRECT", {
				readOnly,
				noDefaultProvider: true,
				currentModel: null,
				defaultModel: null,
				currentGateway: null,
				currentValue: "",
				hasCustomPref: false,
				hasModels: false,
				hierarchicalModels: [],
			}),
		});
		expect(screen.getByText("—")).toBeInTheDocument();
		expect(
			screen.queryByText(
				"Choose a default API provider to select text models.",
			),
		).toBeNull();
		expect(screen.queryByText("No models available")).toBeNull();
		const trigger = screen.queryByRole("button", {
			name: /^Complex work on API billing/,
		});
		if (readOnly) {
			expect(trigger).toBeNull();
		} else {
			expect(trigger).toBeDisabled();
		}
	},
);

it("includes the selected model in the picker trigger's accessible name", () => {
	setup();
	expect(
		screen.getByRole("button", {
			name: /Complex work on API billing.*Example current/,
		}),
	).toBeInTheDocument();
});

describe("model fit markers", () => {
	it("marks a weak option and still lets it be selected", async () => {
		const weak = {
			...models[1],
			suitableForTasks: ["CHAT"],
			qualityTier: "BASIC",
		};
		const currentView = view();
		const onValueChange = vi.fn();
		currentView.hierarchicalModels[0].providers[0].models = [
			models[0],
			weak,
		];
		setup({ view: currentView, onValueChange });
		await userEvent.click(
			screen.getByRole("button", { name: /Example current/ }),
		);
		const marker = await screen.findByRole("img", {
			name: /isn't a good fit/,
		});
		expect(marker).toHaveAccessibleName(/Example second/);
		const option = marker.closest("[cmdk-item]");
		expect(option).not.toHaveAttribute("aria-disabled", "true");
		await userEvent.click(option as HTMLElement);
		expect(onValueChange).toHaveBeenCalledWith(
			`VERCEL_GATEWAY:${weak.canonicalName}`,
		);
	});
	it("does not mark suitable options", async () => {
		const currentView = view();
		currentView.hierarchicalModels[0].providers[0].models = models.map(
			(m) => ({ ...m, suitableForTasks: ["COMPLEX"] }),
		);
		setup({ view: currentView });
		await userEvent.click(
			screen.getByRole("button", { name: /Example current/ }),
		);
		expect(
			screen.queryByRole("img", { name: /weaker|Costs more/ }),
		).toBeNull();
	});
});

// Prices must reach both catalog options and the saved/default fallback pin.
it.each([false, true])(
	"prices Simple picker options (fallback pin: %s)",
	async (fallback) => {
		const expensive = {
			...models[0],
			suitableForTasks: ["SIMPLE"],
			qualityTier: "STANDARD",
			inputCostPer1M: 2,
			outputCostPer1M: 8,
		};
		const cheap = {
			...models[1],
			suitableForTasks: ["SIMPLE"],
			qualityTier: "PREMIUM",
			inputCostPer1M: 0.59,
			outputCostPer1M: 0.79,
		};
		const currentView = view("VERCEL_GATEWAY", {
			taskType: "SIMPLE",
			currentModel: expensive,
		});
		currentView.hierarchicalModels[0].providers[0].models = fallback
			? [cheap]
			: [expensive, cheap];
		setup({ view: currentView });
		await userEvent.click(
			screen.getByRole("button", { name: /Example current/ }),
		);
		const marker = await screen.findByRole("img", {
			name: "Costs more than this task needs.",
		});
		expect(marker.closest("[cmdk-item]")).toHaveTextContent(
			expensive.displayName,
		);
		const cheapOption = screen
			.getByText(cheap.displayName, { selector: "[cmdk-item] span" })
			.closest("[cmdk-item]");
		expect(
			within(cheapOption as HTMLElement).queryByRole("img", {
				name: /Costs more/,
			}),
		).toBeNull();
	},
);
