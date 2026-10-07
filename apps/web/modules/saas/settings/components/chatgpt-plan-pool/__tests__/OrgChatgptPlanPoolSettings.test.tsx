import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pool = vi.hoisted(() => ({
	get: vi.fn(),
	updateAccount: vi.fn(),
	disconnectAccount: vi.fn(),
	updatePolicy: vi.fn(),
	acknowledgeTerms: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { organizations: { chatgptPlanPool: pool } },
}));

const flags = vi.hoisted(() => ({
	current: { CHATGPT_PLAN: true, CHATGPT_PLAN_POOLING: true } as Record<
		string,
		boolean
	>,
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) => flags.current[key] === true,
}));

vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({
		activeOrganization: { slug: "example-org" },
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
		useTranslations:
			(namespace: string) =>
			(key: string, values?: Record<string, string | number>) =>
				lookup(`${namespace}.${key}`).replace(
					/\{(\w+)\}/g,
					(_match, name: string) =>
						values?.[name] === undefined
							? `{${name}}`
							: String(values[name]),
				),
	};
});

import { OrgChatgptPlanPoolSettings } from "../OrgChatgptPlanPoolSettings";

const copy = en.settings.chatgptPlanPool;

const POLICY = {
	poolingEnabled: false,
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
	lastUsedAt: null,
	createdAt: new Date("2026-10-01T00:00:00Z"),
	coolingUntil: null,
	usageEstimate: {
		windowHours: 5,
		requests: 3,
		inputTokens: 375_000,
		outputTokens: 10,
		estimatedPercent: 50,
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
	} = {},
) {
	pool.get.mockResolvedValue({
		policy: { ...POLICY, ...overrides.policy },
		accounts: (overrides.accounts ?? [ACCOUNT]).map((account) => ({
			...ACCOUNT,
			...account,
		})),
		viewer: { isOwner: overrides.isOwner ?? false },
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	flags.current = { CHATGPT_PLAN: true, CHATGPT_PLAN_POOLING: true };
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
		[
			"CHATGPT_PLAN off",
			{ CHATGPT_PLAN: false, CHATGPT_PLAN_POOLING: true },
			true,
		],
		[
			"CHATGPT_PLAN_POOLING off",
			{ CHATGPT_PLAN: true, CHATGPT_PLAN_POOLING: false },
			true,
		],
		[
			"a viewer who is not an admin or owner",
			{ CHATGPT_PLAN: true, CHATGPT_PLAN_POOLING: true },
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

	it("lets an owner accept the terms, and keeps pooling off until then", async () => {
		poolWith({ isOwner: true });
		renderSettings();
		const accept = await screen.findByRole("button", {
			name: copy.acceptTerms,
		});
		expect(
			screen.getByRole("switch", { name: copy.poolingEnabled }),
		).toBeDisabled();
		await userEvent.click(accept);
		await waitFor(() => expect(pool.acknowledgeTerms).toHaveBeenCalled());
	});

	it("tells an admin that only an owner can accept the terms", async () => {
		renderSettings();
		expect(await screen.findByText(copy.ownerOnly)).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: copy.acceptTerms }),
		).toBeNull();
	});

	it("turns pooling on once the terms are accepted", async () => {
		poolWith({
			policy: {
				termsAcknowledged: true,
				termsAcknowledgedAt: new Date("2026-10-02T00:00:00Z") as never,
			},
		});
		renderSettings();
		const pooling = await screen.findByRole("switch", {
			name: copy.poolingEnabled,
		});
		expect(pooling).toBeEnabled();
		await userEvent.click(pooling);
		await waitFor(() =>
			expect(pool.updatePolicy).toHaveBeenCalledWith({
				poolingEnabled: true,
			}),
		);
	});

	it("offers no interactive fallback choice: a spent plan's refusal already asks the member", async () => {
		renderSettings();
		await screen.findByTestId("chatgpt-plan-pool-policy");
		expect(
			document.getElementById("chatgpt-plan-pool-interactive"),
		).toBeNull();
		// Background fallback and headroom are the only choices.
		expect(screen.getAllByRole("combobox")).toHaveLength(2);
	});

	it("warns that background jobs are billed to the organization under AUTO", async () => {
		poolWith({ policy: { apiFallbackBackground: "AUTO" } });
		renderSettings();
		expect(
			await screen.findByTestId("chatgpt-plan-pool-auto-warning"),
		).toHaveTextContent(copy.backgroundAutoWarningTitle);
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
			within(rows[1] as HTMLElement).getByText(copy.statusNeedsReconnect),
		).toBeInTheDocument();
		expect(rows[2]).toHaveTextContent(/Cooling until/);
	});

	it("changes which work an account serves", async () => {
		renderSettings();
		await userEvent.click(
			await screen.findByRole("switch", { name: copy.serveInteractive }),
		);
		await waitFor(() =>
			expect(pool.updateAccount).toHaveBeenCalledWith({
				accountId: "acc-1",
				serveInteractive: true,
			}),
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
				"fabric connect chatgpt --org example-org --shared",
			),
		).toBeInTheDocument();
	});
});
