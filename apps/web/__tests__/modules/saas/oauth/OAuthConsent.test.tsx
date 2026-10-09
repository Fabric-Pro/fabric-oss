/**
 * The consent page of an agent that was connected from a project.
 *
 * What the page shows is a view of what the server will grant, and the server
 * decides it. So the tests here pin what each answer from the binding lookup
 * does to the page: an organization request reads as it always did, a project
 * request names the project and its organization and asks for no organization,
 * and a project the person cannot open leaves nothing to allow.
 */

import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	authorizationBinding: vi.fn(),
	fetch: vi.fn(),
	query: new URLSearchParams(),
	organizations: [] as Array<{ id: string; name: string }>,
	activeOrganizationId: null as string | null,
}));

vi.mock("@repo/auth/client", () => ({
	authClient: { $fetch: mocks.fetch },
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		session: { activeOrganizationId: mocks.activeOrganizationId },
		user: { id: "user-1" },
		loaded: true,
	}),
}));

vi.mock("@saas/organizations/lib/api", () => ({
	useOrganizationListQuery: () => ({ data: mocks.organizations }),
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

/** The real English messages, with `{name}` placeholders filled in. */
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
			(key: string, values?: Record<string, string>) =>
				lookup(`${namespace}.${key}`).replace(
					/\{(\w+)\}/g,
					(_match, name: string) => values?.[name] ?? `{${name}}`,
				),
	};
});

import { OAuthConsent } from "@saas/oauth/components/OAuthConsent";

const words = en.auth.oauth.consent;

function renderConsent() {
	mocks.fetch.mockImplementation(
		async (path: string, options?: { query?: unknown }) => {
			if (path === "/oauth2/public-client") {
				return { data: { client_name: "Example Agent" }, error: null };
			}
			return {
				data: { redirect: true, url: "http://127.0.0.1:49152/cb" },
				error: null,
				options,
			};
		},
	);
	return render(
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
			}
		>
			<OAuthConsent />
		</QueryClientProvider>,
	);
}

const allow = () => screen.getByRole("button", { name: words.allow });

beforeEach(() => {
	vi.clearAllMocks();
	mocks.query = new URLSearchParams({
		client_id: "client-1",
		code_challenge: "challenge-1",
		scope: "mcp:read instructions:read instructions:write offline_access",
		redirect_uri: "http://127.0.0.1:49152/cb",
	});
	mocks.organizations = [{ id: "org-example", name: "Example Org" }];
	mocks.activeOrganizationId = "org-example";
});

describe("an authorization that asks for an organization", () => {
	beforeEach(() => {
		mocks.authorizationBinding.mockResolvedValue({
			bound: false,
			project: null,
		});
	});

	it("reads as it always did: the organization, and the organization's scope words", async () => {
		renderConsent();

		expect(
			await screen.findByRole("heading", {
				name: "Example Agent wants to access Fabric",
			}),
		).toBeInTheDocument();
		expect(screen.getByText("Example Org")).toBeInTheDocument();
		expect(screen.getByText(words.organizationLabel)).toBeInTheDocument();
		expect(screen.getByText(words.scopes["mcp:read"])).toBeInTheDocument();
		expect(screen.queryByText(words.projectLabel)).not.toBeInTheDocument();
		await waitFor(() => expect(allow()).toBeEnabled());
	});

	it("asks the server what it is bound to, by the client and the challenge", async () => {
		renderConsent();
		await screen.findByText("Example Org");

		expect(mocks.authorizationBinding).toHaveBeenCalledWith({
			clientId: "client-1",
			codeChallenge: "challenge-1",
		});
	});

	it("sends its answer with an explicit none for the project it showed, and the organization it showed", async () => {
		renderConsent();
		await screen.findByText("Example Org");
		await waitFor(() => expect(allow()).toBeEnabled());

		await userEvent.click(allow());

		await waitFor(() =>
			expect(mocks.fetch).toHaveBeenCalledWith("/oauth2/consent", {
				method: "POST",
				body: {
					accept: true,
					displayed_binding: null,
					displayed_organization: "org-example",
				},
			}),
		);
	});

	it("still cannot be allowed without an organization", async () => {
		mocks.organizations = [];
		mocks.activeOrganizationId = null;
		renderConsent();

		expect(
			await screen.findByText(words.noOrganization),
		).toBeInTheDocument();
		expect(allow()).toBeDisabled();
	});
});

describe("an authorization that asks for one project", () => {
	const PROJECT = {
		id: "project-example-one",
		name: "Example Project",
		audience: "mcp",
		organizationId: "org-example",
		organizationName: "Example Org",
	};

	beforeEach(() => {
		mocks.authorizationBinding.mockResolvedValue({
			bound: true,
			project: PROJECT,
		});
	});

	it("names the project and its organization in the title", async () => {
		renderConsent();

		expect(
			await screen.findByRole("heading", {
				name: "Example Agent wants access to the project Example Project (Example Org)",
			}),
		).toBeInTheDocument();
		expect(screen.getByTestId("oauth-consent-project")).toHaveTextContent(
			"Example Project (Example Org)",
		);
	});

	it("asks for no organization, and says nothing of choosing one", async () => {
		mocks.organizations = [];
		mocks.activeOrganizationId = null;
		renderConsent();

		await screen.findByTestId("oauth-consent-project");

		expect(
			screen.queryByText(words.organizationLabel),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText(words.noOrganization),
		).not.toBeInTheDocument();
		await waitFor(() => expect(allow()).toBeEnabled());
	});

	it("reads each scope as this project", async () => {
		renderConsent();

		await screen.findByTestId("oauth-consent-project");

		for (const scope of [
			"mcp:read",
			"instructions:read",
			"instructions:write",
			"offline_access",
		] as const) {
			expect(
				screen.getByText(words.scopesProject[scope]),
			).toBeInTheDocument();
		}
		expect(
			screen.queryByText(words.scopes["mcp:read"]),
		).not.toBeInTheDocument();
	});

	it("sends the person's answer to the consent endpoint, with the project it showed", async () => {
		renderConsent();
		await screen.findByTestId("oauth-consent-project");
		await waitFor(() => expect(allow()).toBeEnabled());

		await userEvent.click(allow());

		await waitFor(() =>
			expect(mocks.fetch).toHaveBeenCalledWith("/oauth2/consent", {
				method: "POST",
				body: {
					accept: true,
					displayed_binding: {
						projectId: "project-example-one",
						audience: "mcp",
					},
					displayed_organization: null,
				},
			}),
		);
	});

	it("says which audience it showed", async () => {
		mocks.authorizationBinding.mockResolvedValue({
			bound: true,
			project: { ...PROJECT, audience: "api" },
		});
		renderConsent();
		await screen.findByTestId("oauth-consent-project");
		await waitFor(() => expect(allow()).toBeEnabled());

		await userEvent.click(allow());

		await waitFor(() =>
			expect(mocks.fetch).toHaveBeenCalledWith(
				"/oauth2/consent",
				expect.objectContaining({
					body: expect.objectContaining({
						displayed_binding: {
							projectId: "project-example-one",
							audience: "api",
						},
					}),
				}),
			),
		);
	});

	it("says it showed the project when it is denied too", async () => {
		renderConsent();
		await screen.findByTestId("oauth-consent-project");

		await userEvent.click(screen.getByRole("button", { name: words.deny }));

		await waitFor(() =>
			expect(mocks.fetch).toHaveBeenCalledWith(
				"/oauth2/consent",
				expect.objectContaining({
					body: {
						accept: false,
						displayed_binding: {
							projectId: "project-example-one",
							audience: "mcp",
						},
						displayed_organization: null,
					},
				}),
			),
		);
	});
});

describe("an authorization that asks for a project the person cannot open", () => {
	it("says so, names nothing of the project, and leaves nothing to allow", async () => {
		mocks.authorizationBinding.mockResolvedValue({
			bound: true,
			project: null,
		});
		renderConsent();

		expect(
			await screen.findByText(words.noProjectAccess),
		).toBeInTheDocument();
		expect(allow()).toBeDisabled();
		expect(
			screen.getByRole("heading", {
				name: "Example Agent wants to access Fabric",
			}),
		).toBeInTheDocument();
	});
});

describe("an authorization whose binding cannot be read", () => {
	it("leaves nothing to allow, rather than showing an organization it may not be for", async () => {
		mocks.authorizationBinding.mockRejectedValue(new Error("unreachable"));
		renderConsent();

		expect(await screen.findByText(words.failed)).toBeInTheDocument();
		expect(allow()).toBeDisabled();
	});
});
