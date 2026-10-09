/**
 * The member's own ChatGPT plan card and sharing (Fizzy #2770 I1): an own plan
 * can be shared with the organization on screen when the server allows it,
 * and a shared account the member connected there is shown read-only with
 * the take-back only they may use.
 */
import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const status = vi.fn();
const setOrganizationUse = vi.fn();
const disconnect = vi.fn();
const share = vi.fn();
const takeBack = vi.fn();
const pool = vi.fn();
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		users: {
			chatgptPlan: {
				status: (input: unknown) => status(input),
				setOrganizationUse: (input: unknown) =>
					setOrganizationUse(input),
				disconnect: (input: unknown) => disconnect(input),
				share: (input: unknown) => share(input),
				takeBack: (input: unknown) => takeBack(input),
			},
		},
		organizations: { chatgptPlanPool: { get: () => pool() } },
	},
}));

const flag = { current: true };
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) => key === "CHATGPT_PLAN" && flag.current,
}));

const activeSlug = { current: "example-org" as string | null };
vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({
		activeOrganization:
			activeSlug.current === null ? null : { slug: activeSlug.current },
	}),
}));

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

const pathname = vi.fn(() => "/app/example-org");
vi.mock("next/navigation", () => ({ usePathname: () => pathname() }));

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

import { ChatgptPlanSettings } from "../ChatgptPlanSettings";

const copy = en.settings.chatgptPlan.share;

const ORGANIZATION = {
	slug: "example-org",
	name: "Example Org",
	enabled: true,
	answered: true,
	includeBackgroundJobs: false,
};

const BASE = {
	tier: null,
	subscriptionActiveUntil: null,
	currentOrganization: ORGANIZATION,
	organizations: [
		{ slug: "example-org", name: "Example Org", enabled: true },
	],
	usageEstimate: null,
	sharedPlanServesOwnWork: false,
	sharedPlansServeBackground: false,
	ownPlanSpent: null,
};

const CONNECTED = {
	...BASE,
	connected: true,
	email: "dev@example.com",
	status: "ACTIVE",
	canShare: true,
	sharedHere: [],
};

const SHARED_ACCOUNT = {
	accountId: "acc-1",
	label: "Example Member's ChatGPT plan",
	maskedEmail: "de***@example.com",
	status: "ACTIVE",
	tier: "PLUS",
	enabled: true,
};

function renderWithClient(node: ReactNode) {
	return render(
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
			}
		>
			{node}
		</QueryClientProvider>,
	);
}

async function confirmIn(dialogName: RegExp, buttonName: string) {
	const dialog = await screen.findByRole("alertdialog", { name: dialogName });
	const button = screen
		.getAllByRole("button", { name: buttonName })
		.find((candidate) => dialog.contains(candidate));
	if (!button) {
		throw new Error("confirm button not found in the dialog");
	}
	await userEvent.click(button);
}

beforeEach(() => {
	vi.clearAllMocks();
	flag.current = true;
	activeSlug.current = "example-org";
	share.mockResolvedValue({ accountId: "acc-new" });
	takeBack.mockResolvedValue({ ok: true });
});

describe("sharing an own ChatGPT plan", () => {
	it("shares only after the member confirms", async () => {
		status.mockResolvedValue(CONNECTED);
		renderWithClient(<ChatgptPlanSettings />);

		await userEvent.click(
			await screen.findByRole("button", {
				name: "Share with Example Org",
			}),
		);
		expect(share).not.toHaveBeenCalled();
		await confirmIn(
			/Share your ChatGPT plan with Example Org/,
			copy.confirm,
		);

		await waitFor(() => expect(share).toHaveBeenCalledOnce());
		expect(toasts.success).toHaveBeenCalledWith(
			"Your ChatGPT plan is now shared with Example Org",
		);
	});

	it("offers no sharing when the server says the organization does not take it", async () => {
		status.mockResolvedValue({ ...CONNECTED, canShare: false });
		renderWithClient(<ChatgptPlanSettings />);

		await screen.findByTestId("chatgpt-plan-email");
		expect(screen.queryByTestId("chatgpt-plan-share")).toBeNull();
	});

	it("shows the server's reason when sharing is refused", async () => {
		status.mockResolvedValue(CONNECTED);
		share.mockRejectedValue(
			new Error(
				"This ChatGPT account is already shared by an organization.",
			),
		);
		renderWithClient(<ChatgptPlanSettings />);

		await userEvent.click(
			await screen.findByRole("button", {
				name: "Share with Example Org",
			}),
		);
		await confirmIn(/Share your ChatGPT plan/, copy.confirm);
		await waitFor(() =>
			expect(toasts.error).toHaveBeenCalledWith(
				"This ChatGPT account is already shared by an organization.",
			),
		);
	});
});

describe("a shared account the member connected", () => {
	it("is shown read-only with Take back, which runs after confirming", async () => {
		status.mockResolvedValue({
			...BASE,
			connected: false,
			email: null,
			status: null,
			canShare: false,
			sharedHere: [SHARED_ACCOUNT],
		});
		renderWithClient(<ChatgptPlanSettings />);

		const card = await screen.findByTestId("chatgpt-plan-shared-here");
		expect(card).toHaveTextContent("Shared with Example Org");
		expect(card).toHaveTextContent(SHARED_ACCOUNT.label);
		expect(card).toHaveTextContent(
			"Admins of Example Org manage this account.",
		);
		expect(card.querySelector('[role="switch"]')).toBeNull();

		await userEvent.click(
			screen.getByRole("button", { name: copy.takeBack }),
		);
		expect(takeBack).not.toHaveBeenCalled();
		await confirmIn(/Take back/, copy.takeBack);

		await waitFor(() =>
			expect(takeBack).toHaveBeenCalledWith({ accountId: "acc-1" }),
		);
		expect(toasts.success).toHaveBeenCalledWith(copy.takenBack);
	});

	it("cannot be taken back while the member has an own plan, and says why", async () => {
		status.mockResolvedValue({
			...CONNECTED,
			canShare: false,
			sharedHere: [SHARED_ACCOUNT],
		});
		renderWithClient(<ChatgptPlanSettings />);

		const card = await screen.findByTestId("chatgpt-plan-shared-here");
		expect(
			screen.getByRole("button", { name: copy.takeBack }),
		).toBeDisabled();
		expect(card).toHaveTextContent(copy.takeBackBlocked);
	});
});
