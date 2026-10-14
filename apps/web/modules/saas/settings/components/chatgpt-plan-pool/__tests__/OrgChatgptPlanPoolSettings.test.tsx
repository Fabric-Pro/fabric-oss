import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pool = vi.hoisted(() => ({
	get: vi.fn(),
	updateAccount: vi.fn(),
	disconnectAccount: vi.fn(),
	updatePolicy: vi.fn(),
	acknowledgeTerms: vi.fn(),
	testAccount: vi.fn(),
}));
const takeBack = vi.hoisted(() => vi.fn());
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		organizations: { chatgptPlanPool: pool },
		users: { chatgptPlan: { takeBack } },
	},
}));

const flags = vi.hoisted(() => ({
	current: { CHATGPT_PLAN: true } as Record<string, boolean>,
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) => flags.current[key] === true,
}));

vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({
		activeOrganization: { slug: "example-org" },
		isSessionOnActiveOrganization: true,
	}),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("next-intl", () => {
	const lookup = (path: string): string => {
		let node: unknown = en;
		for (const segment of path.split(".")) {
			node =
				typeof node === "object" && node !== null
					? Reflect.get(node, segment)
					: undefined;
		}
		return typeof node === "string" ? node : path;
	};
	return {
		useTranslations: (namespace: string) =>
			Object.assign(
				(key: string, values?: Record<string, string | number>) =>
					lookup(`${namespace}.${key}`).replace(
						/\{(\w+)\}/g,
						(_match, name: string) =>
							values?.[name] === undefined
								? `{${name}}`
								: String(values[name]),
					),
				{
					has: (key: string) =>
						lookup(`${namespace}.${key}`) !== `${namespace}.${key}`,
				},
			),
	};
});

import { OrgChatgptPlanPoolSettings } from "../OrgChatgptPlanPoolSettings";

const copy = en.settings.chatgptPlanPool;

const POLICY = {
	apiFallbackInteractive: "ASK",
	apiFallbackBackground: "NEVER",
	headroomPct: 40,
	termsAcknowledged: false,
	termsAcknowledgedAt: null,
};

const ACCOUNT = {
	id: "acc-1",
	label: "Shared plan 1",
	maskedEmail: "sh***@example.com",
	status: "ACTIVE",
	tier: "PLUS",
	enabled: true,
	serveInteractive: false,
	serveBackground: true,
	maxMemberSharePct: null as number | null,
	subscriptionActiveUntil: null as Date | null,
	lastUsedAt: null,
	createdAt: new Date("2026-10-01T00:00:00Z"),
	coolingUntil: null,
	connectedByName: "Example Admin" as string | null,
	viewerIsConnector: false,
	usageEstimate: {
		windowHours: 5,
		windowStart: new Date("2026-10-08T01:37:00Z"),
		resetsAt: new Date("2026-10-08T06:37:00Z"),
		lastRequestAt: new Date("2026-10-08T03:33:00Z"),
		requests: 3,
		inputTokens: 1_000_000,
		cachedInputTokens: 250_000,
		outputTokens: 10,
		estimatedPercent: 50,
		weeklyLimitOnly: false,
		topConsumers: [
			{
				kind: "job" as const,
				key: "teams-channel-monitor",
				requests: 2,
				inputTokens: 920_000,
				percent: 92,
			},
			{
				kind: "feature" as const,
				key: "advisor",
				requests: 1,
				inputTokens: 80_000,
				percent: 8,
			},
		],
	},
};

function renderSettings(canManage = true) {
	return render(
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
			}
		>
			<OrgChatgptPlanPoolSettings
				canManage={canManage}
				organizationSlug="example-org"
			/>
		</QueryClientProvider>,
	);
}

function poolWith(
	overrides: {
		policy?: Partial<typeof POLICY>;
		accounts?: Array<Partial<typeof ACCOUNT>>;
		isOwner?: boolean;
		hasOwnPlan?: boolean;
	} = {},
) {
	pool.get.mockResolvedValue({
		policy: { ...POLICY, ...overrides.policy },
		accounts: (overrides.accounts ?? [ACCOUNT]).map((account) => ({
			...ACCOUNT,
			...account,
		})),
		viewer: {
			isOwner: overrides.isOwner ?? false,
			hasOwnPlan: overrides.hasOwnPlan ?? false,
		},
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	flags.current = { CHATGPT_PLAN: true };
	for (const fn of [
		pool.updateAccount,
		pool.disconnectAccount,
		pool.updatePolicy,
		pool.acknowledgeTerms,
	]) {
		fn.mockResolvedValue({});
	}
	poolWith();
});

// Fizzy #2770: the organization's shared ChatGPT plans, managed by its
// admins and owners on the AI Providers page.
describe("Shared ChatGPT plans settings", () => {
	it.each([
		["CHATGPT_PLAN off", { CHATGPT_PLAN: false }, true],
		[
			"a viewer who is not an admin or owner",
			{ CHATGPT_PLAN: true },
			false,
		],
	])(
		"renders nothing and fetches nothing for %s",
		(_case, flagState, canManage) => {
			flags.current = flagState;
			renderSettings(canManage);
			expect(screen.queryByText(copy.title)).toBeNull();
			expect(pool.get).not.toHaveBeenCalled();
		},
	);

	// Fizzy #2770: CHATGPT_PLAN alone gates shared plans; no second flag.
	it("shows the shared accounts with CHATGPT_PLAN alone on", async () => {
		renderSettings();
		expect(
			await screen.findAllByTestId("chatgpt-plan-pool-account"),
		).toHaveLength(1);
		expect(pool.get).toHaveBeenCalled();
	});

	// Fizzy #2770 F6: one home for the policy — AI Models, with the routing.
	it("links to the policy on AI Models and keeps no policy controls here", async () => {
		renderSettings();
		const link = await screen.findByTestId("chatgpt-plan-pool-policy-link");
		expect(link).toHaveTextContent(copy.policyLink);
		expect(link).toHaveAttribute(
			"href",
			"/app/example-org/settings/ai-models",
		);
		await screen.findAllByTestId("chatgpt-plan-pool-account");
		expect(screen.queryByTestId("chatgpt-plan-pool-policy")).toBeNull();
		expect(
			screen.queryByRole("button", { name: copy.acceptTerms }),
		).toBeNull();
	});

	it("shows the window ChatGPT reported, and its weekly limit, in place of the estimate", async () => {
		poolWith({
			accounts: [
				{
					...ACCOUNT,
					usageEstimate: {
						...ACCOUNT.usageEstimate,
						percent: 73,
						percentSource: "reported",
						reported: {
							windowUsedPercent: 73,
							windowResetsAt: null,
							weeklyUsedPercent: 22,
							weeklyResetsAt: null,
							observedAt: new Date(),
							fresh: true,
						},
					},
				},
			],
		});
		renderSettings();
		const [row] = await screen.findAllByTestId("chatgpt-plan-pool-account");
		expect(row).toHaveTextContent(
			"73% of a 5-hour window used (reported by ChatGPT)",
		);
		expect(row).not.toHaveTextContent(/\(estimate\)/);
		expect(
			within(row as HTMLElement).getByTestId(
				"chatgpt-plan-window-weekly",
			),
		).toHaveTextContent("Weekly limit: 22% used (reported by ChatGPT)");
	});

	it("shows each account's status, masked address and estimated window", async () => {
		poolWith({
			accounts: [
				ACCOUNT,
				{
					id: "acc-2",
					label: "Shared plan 2",
					status: "NEEDS_RECONNECT",
				},
				{
					id: "acc-3",
					label: "Shared plan 3",
					coolingUntil: new Date(Date.now() + 60 * 60_000) as never,
				},
			],
		});
		renderSettings();
		const rows = await screen.findAllByTestId("chatgpt-plan-pool-account");
		expect(rows).toHaveLength(3);
		expect(
			within(rows[0] as HTMLElement).getByText(copy.statusActive),
		).toBeInTheDocument();
		expect(
			within(rows[0] as HTMLElement).getByText("sh***@example.com"),
		).toBeInTheDocument();
		expect(rows[0]).toHaveTextContent(
			/About 50% of a 5-hour window .*\(estimate\)/,
		);
		expect(
			within(rows[0] as HTMLElement).getByTestId(
				"chatgpt-plan-window-timing",
			),
		).toHaveTextContent(
			/^Last request \d\d:\d\d( [AP]M)? · resets at \d\d:\d\d( [AP]M)?$/,
		);
		// A job with a label reads as words; one without, as its raw key.
		expect(
			within(rows[0] as HTMLElement).getByTestId(
				"chatgpt-plan-window-consumers",
			),
		).toHaveTextContent("Used by: Teams channel monitor 92% · advisor 8%");
		expect(
			within(rows[1] as HTMLElement).getByText(copy.statusNeedsReconnect),
		).toBeInTheDocument();
		expect(rows[2]).toHaveTextContent(/Cooling until/);
	});

	// Fizzy #2770: one "Serves" choice replaces the three switches.
	it.each([
		[
			copy.servesEverything,
			{ enabled: true, serveInteractive: true, serveBackground: true },
		],
		[copy.servesPaused, { enabled: false }],
	])("changes which work an account serves to %s", async (choice, sent) => {
		renderSettings();
		const serves = await screen.findByRole("combobox", {
			name: `${copy.serves} — Shared plan 1`,
		});
		expect(serves).toHaveTextContent(copy.servesBackground);
		expect(screen.queryByRole("switch")).toBeNull();
		await userEvent.click(serves);
		const options = await screen.findAllByRole("option");
		expect(options.map((option) => option.textContent)).toEqual([
			copy.servesEverything,
			copy.servesBackground,
			copy.servesPaused,
		]);
		await userEvent.click(screen.getByRole("option", { name: choice }));
		await waitFor(() =>
			expect(pool.updateAccount).toHaveBeenCalledWith({
				accountId: "acc-1",
				...sent,
			}),
		);
	});

	it("sets an account to serve background jobs only", async () => {
		poolWith({ accounts: [{ ...ACCOUNT, serveInteractive: true }] });
		renderSettings();
		const serves = await screen.findByRole("combobox", {
			name: `${copy.serves} — Shared plan 1`,
		});
		expect(serves).toHaveTextContent(copy.servesEverything);
		await userEvent.click(serves);
		await userEvent.click(
			await screen.findByRole("option", { name: copy.servesBackground }),
		);
		await waitFor(() =>
			expect(pool.updateAccount).toHaveBeenCalledWith({
				accountId: "acc-1",
				enabled: true,
				serveInteractive: false,
				serveBackground: true,
			}),
		);
	});

	it("reads a disabled account as Paused", async () => {
		poolWith({ accounts: [{ ...ACCOUNT, enabled: false }] });
		renderSettings();
		expect(
			await screen.findByRole("combobox", {
				name: `${copy.serves} — Shared plan 1`,
			}),
		).toHaveTextContent(copy.servesPaused);
	});

	// An account an earlier version left serving members only keeps reading
	// so, but that choice is never offered.
	it("shows a legacy members-only account, without offering that choice", async () => {
		poolWith({
			accounts: [
				{ ...ACCOUNT, serveInteractive: true, serveBackground: false },
			],
		});
		renderSettings();
		const serves = await screen.findByRole("combobox", {
			name: `${copy.serves} — Shared plan 1`,
		});
		expect(serves).toHaveTextContent(copy.servesMembersOnly);
		await userEvent.click(serves);
		expect(
			await screen.findByRole("option", { name: copy.servesMembersOnly }),
		).toHaveAttribute("aria-disabled", "true");
	});

	// Fizzy #2770 D6: fair share, offered where the account serves members.
	it("sets a member's fair share on an account that serves members", async () => {
		poolWith({
			accounts: [
				{ ...ACCOUNT, serveInteractive: true, maxMemberSharePct: 25 },
				{ id: "acc-2", label: "Shared plan 2" },
			],
		});
		renderSettings();
		const advanced = await screen.findByTestId(
			"chatgpt-plan-pool-acc-1-advanced",
		);
		expect(
			screen.queryByTestId("chatgpt-plan-pool-acc-2-advanced"),
		).toBeNull();
		expect(
			screen.queryByRole("combobox", {
				name: `${copy.memberShare} — Shared plan 1`,
			}),
		).toBeNull();
		await userEvent.click(
			within(advanced).getByRole("button", { name: copy.advanced }),
		);
		const share = await screen.findByRole("combobox", {
			name: "Each member may use — Shared plan 1",
		});
		expect(share).toHaveTextContent("25%");
		expect(advanced).toHaveTextContent(
			"The most of this account's 5-hour window one member's work can take. Past it, their work moves to the organization's other shared accounts.",
		);

		// No cap is all of the window: 100% stores null.
		await userEvent.click(share);
		await userEvent.click(
			await screen.findByRole("option", { name: "100%" }),
		);
		await waitFor(() =>
			expect(pool.updateAccount).toHaveBeenCalledWith({
				accountId: "acc-1",
				maxMemberSharePct: null,
			}),
		);
	});

	it("shows an uncapped member share as 100%", async () => {
		poolWith({
			accounts: [
				{ ...ACCOUNT, serveInteractive: true, maxMemberSharePct: null },
			],
		});
		renderSettings();
		const advanced = await screen.findByTestId(
			"chatgpt-plan-pool-acc-1-advanced",
		);
		await userEvent.click(
			within(advanced).getByRole("button", { name: copy.advanced }),
		);
		const share = await screen.findByRole("combobox", {
			name: "Each member may use — Shared plan 1",
		});
		expect(share).toHaveTextContent("100%");
		await userEvent.click(share);
		expect(
			await screen.findAllByRole("option", { name: "100%" }),
		).toHaveLength(1);
		await userEvent.click(
			await screen.findByRole("option", { name: "50%" }),
		);
		await waitFor(() =>
			expect(pool.updateAccount).toHaveBeenCalledWith({
				accountId: "acc-1",
				maxMemberSharePct: 50,
			}),
		);
	});

	it.each([
		[
			"Serves",
			"Which work this account takes. Members who connected their own plan always use it first.",
		],
		[
			"Plan type",
			"OpenAI doesn't tell Fabric the plan type. Set it so the usage estimate matches the plan's limits.",
		],
		[
			"the usage estimate",
			"Fabric's estimate of this 5-hour window, based on calls Fabric made. Use outside Fabric isn't counted.",
		],
	])("explains %s in a tooltip a keyboard reaches", async (setting, text) => {
		renderSettings();
		const trigger = await screen.findByRole("button", {
			name: `About ${setting}`,
		});
		act(() => trigger.focus());
		expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
	});

	it("offers no fair share on a paused account", async () => {
		poolWith({
			accounts: [{ ...ACCOUNT, enabled: false, serveInteractive: true }],
		});
		renderSettings();
		await screen.findByTestId("chatgpt-plan-pool-account");
		expect(
			screen.queryByTestId("chatgpt-plan-pool-acc-1-advanced"),
		).toBeNull();
	});

	// Fizzy #2770 G7: what the account's sign-in says about its subscription.
	it("shows each account's tier, a Free warning and a Pro plan's weekly-only limit", async () => {
		poolWith({
			accounts: [
				{ ...ACCOUNT, tier: "FREE" },
				{
					id: "acc-2",
					label: "Shared plan 2",
					tier: "PRO",
					usageEstimate: {
						...ACCOUNT.usageEstimate,
						weeklyLimitOnly: true,
					},
				},
			],
		});
		renderSettings();
		const rows = await screen.findAllByTestId("chatgpt-plan-pool-account");
		expect(rows[0]).toHaveTextContent(
			en.settings.chatgptPlan.subscription.freeWarning,
		);
		expect(
			within(rows[1] as HTMLElement).getByTestId(
				"chatgpt-plan-subscription",
			),
		).toHaveTextContent(en.settings.chatgptPlan.subscription.tier.PRO);
		expect(rows[1]).toHaveTextContent(
			en.settings.chatgptPlan.weeklyLimitOnly,
		);
		expect(rows[1]).not.toHaveTextContent(/of a 5-hour window/);
	});

	// OpenAI's sign-in does not report the plan, so an admin may set it; until
	// then it reads "Not set" and no tier badge is shown.
	it("shows an unset plan type as Not set, with no tier badge", async () => {
		poolWith({ accounts: [{ ...ACCOUNT, tier: "UNKNOWN" }] });
		renderSettings();
		const planType = await screen.findByRole("combobox", {
			name: `${copy.planType} — Shared plan 1`,
		});
		expect(planType).toHaveTextContent(copy.planTypeNotSet);
		expect(
			screen.getByTestId("chatgpt-plan-subscription"),
		).toHaveTextContent(/^$/);
	});

	it("shows a set plan type in the select and as a badge", async () => {
		poolWith({ accounts: [{ ...ACCOUNT, tier: "TEAM" }] });
		renderSettings();
		expect(
			await screen.findByRole("combobox", {
				name: `${copy.planType} — Shared plan 1`,
			}),
		).toHaveTextContent(en.settings.chatgptPlan.subscription.tier.TEAM);
		expect(
			screen.getByTestId("chatgpt-plan-subscription"),
		).toHaveTextContent(en.settings.chatgptPlan.subscription.tier.TEAM);
	});

	it("saves the chosen plan type", async () => {
		poolWith({ accounts: [{ ...ACCOUNT, tier: "UNKNOWN" }] });
		renderSettings();
		await userEvent.click(
			await screen.findByRole("combobox", {
				name: `${copy.planType} — Shared plan 1`,
			}),
		);
		const options = await screen.findAllByRole("option");
		expect(options.map((option) => option.textContent)).toEqual([
			copy.planTypeNotSet,
			"Plus",
			"Pro",
		]);
		await userEvent.click(screen.getByRole("option", { name: "Pro" }));
		await waitFor(() =>
			expect(pool.updateAccount).toHaveBeenCalledWith({
				accountId: "acc-1",
				tier: "PRO",
			}),
		);
		await waitFor(() => expect(pool.get).toHaveBeenCalledTimes(2));
	});

	it("clears a set plan type back to Not set", async () => {
		poolWith({ accounts: [{ ...ACCOUNT, tier: "PRO" }] });
		renderSettings();
		await userEvent.click(
			await screen.findByRole("combobox", {
				name: `${copy.planType} — Shared plan 1`,
			}),
		);
		await userEvent.click(
			await screen.findByRole("option", { name: copy.planTypeNotSet }),
		);
		await waitFor(() =>
			expect(pool.updateAccount).toHaveBeenCalledWith({
				accountId: "acc-1",
				tier: "UNKNOWN",
			}),
		);
	});

	// Fizzy #2770 I1: only the member who connected it may stop sharing it.
	it("names who connected each account and offers Stop sharing to them alone", async () => {
		poolWith({
			accounts: [
				{ id: "acc-1", label: "Shared plan 1" },
				{
					id: "acc-2",
					label: "Shared plan 2",
					connectedByName: null,
					viewerIsConnector: true,
				},
			],
		});
		takeBack.mockResolvedValue({ ok: true });
		renderSettings();

		const [first, second] = await screen.findAllByTestId(
			"chatgpt-plan-pool-account",
		);
		expect(first).toHaveTextContent("Connected by Example Admin");
		expect(
			within(first as HTMLElement).queryByRole("button", {
				name: copy.takeBack,
			}),
		).toBeNull();
		expect(second).toHaveTextContent(copy.connectedByYou);

		await userEvent.click(
			within(second as HTMLElement).getByRole("button", {
				name: copy.takeBack,
			}),
		);
		expect(takeBack).not.toHaveBeenCalled();
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent(copy.takeBackConfirmBody);
		await userEvent.click(
			within(dialog).getByRole("button", { name: copy.takeBack }),
		);
		await waitFor(() =>
			expect(takeBack).toHaveBeenCalledWith({ accountId: "acc-2" }),
		);
	});

	it("blocks Stop sharing while the connector has an own plan, saying why", async () => {
		poolWith({
			accounts: [{ viewerIsConnector: true }],
			hasOwnPlan: true,
		});
		renderSettings();
		const row = await screen.findByTestId("chatgpt-plan-pool-account");
		expect(
			within(row).getByRole("button", { name: copy.takeBack }),
		).toBeDisabled();
		expect(row).toHaveTextContent(
			en.settings.chatgptPlan.share.takeBackBlocked,
		);
	});

	it("disconnects an account only after confirming", async () => {
		renderSettings();
		await userEvent.click(
			await screen.findByRole("button", { name: copy.disconnect }),
		);
		expect(pool.disconnectAccount).not.toHaveBeenCalled();
		const dialog = await screen.findByRole("alertdialog");
		await userEvent.click(
			within(dialog).getByRole("button", { name: copy.disconnect }),
		);
		await waitFor(() =>
			expect(pool.disconnectAccount).toHaveBeenCalledWith({
				accountId: "acc-1",
			}),
		);
	});

	it("shows the command that connects the first account", async () => {
		poolWith({ accounts: [] });
		renderSettings();
		expect(await screen.findByText(copy.emptyAccounts)).toBeInTheDocument();
		expect(
			screen.getByText(
				`fabric connect chatgpt --org example-org --shared --base-url ${window.location.origin}`,
			),
		).toBeInTheDocument();
	});

	// Each account row repeats the same settings: the accessible name says
	// which account a control belongs to.
	it("names each Serves choice with its account", async () => {
		poolWith({
			accounts: [ACCOUNT, { id: "acc-2", label: "Shared plan 2" }],
		});
		renderSettings();
		expect(
			await screen.findByRole("combobox", {
				name: `${copy.serves} — Shared plan 2`,
			}),
		).toBeInTheDocument();
		expect(
			screen.getByRole("combobox", {
				name: `${copy.serves} — Shared plan 1`,
			}),
		).toBeInTheDocument();
	});

	// Fizzy #2770: a Test button on each account, like an API provider's.
	it("tests the account it names and shows that it works beside its button", async () => {
		poolWith({
			accounts: [ACCOUNT, { id: "acc-2", label: "Shared plan 2" }],
		});
		pool.testAccount.mockResolvedValue({
			outcome: "ok",
			model: "gpt-6-luna",
			modelName: "GPT-6 Luna",
			latencyMs: 1200,
		});
		renderSettings();
		await userEvent.click(
			await screen.findByRole("button", { name: "Test Shared plan 2" }),
		);

		expect(pool.testAccount).toHaveBeenCalledExactlyOnceWith({
			accountId: "acc-2",
		});
		const [first, second] = screen.getAllByTestId(
			"chatgpt-plan-test-result",
		);
		await waitFor(() =>
			expect(second).toHaveTextContent("Works · GPT-6 Luna · 1.2 s"),
		);
		expect(first).toBeEmptyDOMElement();
		// The pool is read again: a test can change an account's status.
		await waitFor(() => expect(pool.get).toHaveBeenCalledTimes(2));
	});

	it("disables Test while it runs, then shows when a spent window resets", async () => {
		let finish: (value: unknown) => void = () => {};
		pool.testAccount.mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		renderSettings();
		const button = await screen.findByRole("button", {
			name: "Test Shared plan 1",
		});
		await userEvent.click(button);
		await waitFor(() => expect(button).toBeDisabled());

		finish({
			outcome: "spent",
			resetAt: new Date("2026-10-09T18:50:00Z"),
		});
		await waitFor(() => expect(button).toBeEnabled());
		expect(
			screen.getByTestId("chatgpt-plan-test-result"),
		).toHaveTextContent(/^Usage limit reached until \d\d:\d\d/);
	});

	it.each([
		[{ outcome: "needs_reconnect", message: "x" }, "Needs reconnect"],
		[{ outcome: "spent", resetAt: null }, "Usage limit reached"],
		[
			{
				outcome: "error",
				message: "This account cannot use plan access",
			},
			"Test failed: This account cannot use plan access",
		],
	])("reads a %o test as %s", async (result, text) => {
		pool.testAccount.mockResolvedValue(result);
		renderSettings();
		await userEvent.click(
			await screen.findByRole("button", { name: "Test Shared plan 1" }),
		);
		await waitFor(() =>
			expect(
				screen.getByTestId("chatgpt-plan-test-result"),
			).toHaveTextContent(new RegExp(`^${text}$`)),
		);
	});
});
