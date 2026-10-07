import en from "@repo/i18n/translations/en.json";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => (key: string) => {
		let node: unknown = en;
		for (const segment of `${namespace}.${key}`.split(".")) {
			node =
				typeof node === "object" && node !== null
					? Reflect.get(node, segment)
					: undefined;
		}
		return String(node);
	},
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const discovery = vi.hoisted(() => ({
	current: { status: "unavailable" } as Record<string, unknown>,
}));
vi.mock(
	"@saas/projects/components/cli-connection/lib/use-cli-discovery",
	() => ({ useCliDiscovery: () => discovery.current }),
);

import { ChatgptConnectCommand } from "../ChatgptConnectCommand";

const copy = en.settings.chatgptPlan.cli;

beforeEach(() => {
	discovery.current = { status: "unavailable" };
});

// Fizzy #2770: the command a deployment shows must run against that
// deployment.
describe("ChatgptConnectCommand", () => {
	it("runs the CLI this deployment serves, signed in at this page's address", async () => {
		discovery.current = {
			status: "ready",
			document: {
				spec: 1,
				version: "0.4.0",
				minSupported: "0.4.0",
				nodeRange: ">=22",
				origin: null,
				integrity: "sha512-abc=",
				tarball:
					"https://build.example.com/cli/fabric-0.4.0-0123456789.tgz",
			},
		};
		render(<ChatgptConnectCommand sharedOrganizationSlug="example-org" />);
		const origin = window.location.origin;
		await waitFor(() =>
			expect(
				screen.getByTestId("chatgpt-connect-line"),
			).toHaveTextContent(
				`npx -y ${origin}/cli/fabric-0.4.0-0123456789.tgz connect chatgpt --org example-org --shared --base-url ${origin}`,
			),
		);
		await userEvent.click(
			screen.getByRole("button", { name: copy.helpLabel }),
		);
		const help = await screen.findByTestId("chatgpt-connect-help");
		expect(help).toHaveTextContent(copy.servedPrimary);
		expect(help).toHaveTextContent("npm i -g @fabricorg/cli");
	});

	it("shows the installed CLI and how to install it when the deployment serves none", async () => {
		render(<ChatgptConnectCommand />);
		expect(screen.getByTestId("chatgpt-connect-line")).toHaveTextContent(
			/^fabric connect chatgpt$/,
		);
		await userEvent.click(
			screen.getByRole("button", { name: copy.helpLabel }),
		);
		const help = await screen.findByTestId("chatgpt-connect-help");
		expect(help).toHaveTextContent(copy.installFirst);
		expect(help).toHaveTextContent("npm i -g @fabricorg/cli");
	});
});
