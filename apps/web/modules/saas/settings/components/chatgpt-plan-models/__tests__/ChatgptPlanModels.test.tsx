import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getModels = vi.fn();
const setModel = vi.fn();
const setFallback = vi.fn();
const status = vi.fn();
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		organizations: {
			chatgptPlanModels: {
				get: (input: unknown) => getModels(input),
				set: (input: unknown) => setModel(input),
				setFallback: (input: unknown) => setFallback(input),
			},
		},
		users: {
			chatgptPlan: { status: (input: unknown) => status(input) },
		},
	},
}));

const flag = { current: true };
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) => key === "CHATGPT_PLAN" && flag.current,
}));

vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({
		activeOrganization: { slug: "example-org" },
	}),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("next/navigation", () => ({ usePathname: () => "/app/example-org" }));

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

import { ChatgptPlanSettings } from "../../chatgpt-plan/ChatgptPlanSettings";
import { ConnectChatgptPlanForm } from "../../chatgpt-plan/ConnectChatgptPlanForm";

const copy = en.settings.chatgptPlanModels;

const SOL = { canonicalName: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" };
const LUNA = { canonicalName: "gpt-5.6-luna", displayName: "GPT-5.6 Luna" };

const option = (
	model: { canonicalName: string; displayName: string },
	newest = false,
) => ({
	...model,
	slug: model.canonicalName,
	description: null,
	autoDetected: false,
	newest,
});

function choices(canEdit: boolean) {
	return {
		tasks: [
			{
				taskType: "COMPLEX",
				model: LUNA,
				source: "organization",
				noLongerServed: false,
			},
			{
				taskType: "SIMPLE",
				model: LUNA,
				source: "default",
				noLongerServed: false,
			},
		],
		models: [option(SOL), option(LUNA)],
		fallbackModel: "gpt-6-astra" as string | null,
		recommendedFallbackModel: "gpt-6-astra",
		servedCheckedAt: null as Date | null,
		canEdit,
	};
}

function wrap(node: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{node}</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	flag.current = true;
	getModels.mockResolvedValue(choices(true));
	setModel.mockResolvedValue(choices(true));
});

describe("where a member connects or holds a plan", () => {
	it("lists the organization's models on the approval page", () => {
		render(
			<ConnectChatgptPlanForm
				email="dev@example.com"
				organizations={[
					{
						id: "org-a",
						name: "Example Org",
						enabled: true,
						models: choices(false).tasks,
					},
				]}
				port={54321}
				state="state-example"
			/>,
		);
		expect(
			screen.getByText(
				copy.connectNote.replace("{organization}", "Example Org"),
			),
		).toBeVisible();
		expect(screen.getByTestId("chatgpt-plan-model-list")).toHaveTextContent(
			`${copy.tasks.COMPLEX}${LUNA.displayName}`,
		);
	});

	it("shows the organization's models read-only in the plan card", async () => {
		status.mockResolvedValue({
			connected: true,
			email: "dev@example.com",
			status: "ACTIVE",
			currentOrganization: {
				slug: "example-org",
				name: "Example Org",
				enabled: true,
				includeBackgroundJobs: false,
			},
			usageEstimate: null,
			ownPlanSpent: null,
			sharedPlanServesOwnWork: false,
		});
		getModels.mockResolvedValue(choices(false));
		wrap(<ChatgptPlanSettings />);
		expect(await screen.findByText(copy.memberNote)).toBeVisible();
		expect(screen.getByTestId("chatgpt-plan-model-list")).toBeVisible();
		expect(screen.queryByRole("combobox")).toBeNull();
	});
});
