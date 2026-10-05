/**
 * The organization page of an authorization.
 *
 * It asks which organization an agent is for, once, when the person belongs to
 * several. An agent that asked for one project has no organization to choose:
 * the authorization server sends it here only when the person cannot open the
 * project, and the page then says so and has no way to go on.
 */

import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	authorizationBinding: vi.fn(),
	query: new URLSearchParams(),
}));

vi.mock("@repo/auth/client", () => ({ authClient: { $fetch: vi.fn() } }));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ session: { activeOrganizationId: "org-alpha" } }),
}));

vi.mock("@saas/organizations/lib/api", () => ({
	useOrganizationListQuery: () => ({
		data: [
			{ id: "org-alpha", name: "Alpha" },
			{ id: "org-beta", name: "Beta" },
		],
		isLoading: false,
	}),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		users: {
			oauthConnections: {
				authorizationBinding: (input: unknown) =>
					mocks.authorizationBinding(input),
			},
		},
	},
}));

vi.mock("next/navigation", () => ({
	useSearchParams: () => mocks.query,
}));

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
		useTranslations: (namespace: string) => (key: string) =>
			lookup(`${namespace}.${key}`),
	};
});

import { OAuthOrganizationPicker } from "@saas/oauth/components/OAuthOrganizationPicker";

const words = en.auth.oauth.organization;

function renderPicker() {
	return render(
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
			}
		>
			<OAuthOrganizationPicker />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.query = new URLSearchParams({
		client_id: "client-1",
		code_challenge: "challenge-1",
	});
});

describe("the organization page", () => {
	it("offers the organizations to choose from, for an agent that asked for an organization", async () => {
		mocks.authorizationBinding.mockResolvedValue({
			bound: false,
			project: null,
		});
		renderPicker();

		expect(
			await screen.findByRole("radio", { name: "Alpha" }),
		).toBeInTheDocument();
		expect(screen.getByRole("radio", { name: "Beta" })).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: words.continue }),
		).toBeInTheDocument();
		expect(
			screen.queryByText(words.noProjectAccess),
		).not.toBeInTheDocument();
	});

	it("says the project cannot be connected, and offers nothing to continue with, for a project the person cannot open", async () => {
		mocks.authorizationBinding.mockResolvedValue({
			bound: true,
			project: null,
		});
		renderPicker();

		expect(
			await screen.findByText(words.noProjectAccess),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: words.noProjectAccessTitle }),
		).toBeInTheDocument();
		expect(screen.queryByRole("radio")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: words.continue }),
		).not.toBeInTheDocument();
	});
});
