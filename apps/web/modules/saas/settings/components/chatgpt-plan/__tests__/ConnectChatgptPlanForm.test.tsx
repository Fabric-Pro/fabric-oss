import en from "@repo/i18n/translations/en.json";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
	useTranslations:
		(namespace: string) =>
		(key: string, values?: Record<string, string>) => {
			let node: unknown = en;
			for (const segment of `${namespace}.${key}`.split(".")) {
				node =
					typeof node === "object" && node !== null
						? Reflect.get(node, segment)
						: undefined;
			}
			return String(node).replace(
				/\{(\w+)\}/g,
				(_match, name: string) => values?.[name] ?? name,
			);
		},
}));

import { ConnectChatgptPlanForm } from "../ConnectChatgptPlanForm";

const copy = en.settings.chatgptPlan.connect;
const assign = vi.fn();
const fetchSpy = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("fetch", fetchSpy);
	vi.stubGlobal("location", { ...window.location, assign });
	fetchSpy.mockResolvedValue(
		new Response(JSON.stringify({ ticket: "ticket-example" }), {
			status: 200,
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const ORGS = [
	{ id: "org-a", name: "Example Org", enabled: false },
	{ id: "org-b", name: "Example Two", enabled: false },
];

describe("Connect ChatGPT plan page", () => {
	it("pre-checks the only organization that allows it", () => {
		render(
			<ConnectChatgptPlanForm
				email="dev@example.com"
				organizations={[ORGS[0] as (typeof ORGS)[number]]}
				port={54321}
				state="state-example"
			/>,
		);
		expect(
			screen.getByRole("checkbox", { name: "Example Org" }),
		).toBeChecked();
	});

	it("refuses to connect when no organization allows it, and lets the CLI stop waiting", async () => {
		render(
			<ConnectChatgptPlanForm
				email="dev@example.com"
				organizations={[]}
				port={54321}
				state="state-example"
			/>,
		);
		expect(screen.getByText(copy.noOrganizations)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: copy.approve })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: copy.close }));
		const target = new URL(String(assign.mock.calls[0]?.[0]));
		expect(target.searchParams.get("error")).toBe(
			"chatgpt_plan_not_enabled",
		);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("approves the ticked organizations and hands the ticket only to the CLI's loopback", async () => {
		render(
			<ConnectChatgptPlanForm
				email="dev@example.com"
				organizations={ORGS}
				port={54321}
				state="state-example"
			/>,
		);
		expect(
			screen.getByRole("checkbox", { name: "Example Two" }),
		).not.toBeChecked();
		await userEvent.click(
			screen.getByRole("checkbox", { name: "Example Two" }),
		);
		await userEvent.click(
			screen.getByRole("button", { name: copy.approve }),
		);

		await waitFor(() => expect(assign).toHaveBeenCalledOnce());
		expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
			organizationIds: ["org-b"],
		});
		const target = new URL(String(assign.mock.calls[0]?.[0]));
		expect(target.origin).toBe("http://127.0.0.1:54321");
		expect(target.pathname).toBe("/fabric/callback");
		expect(target.searchParams.get("ticket")).toBe("ticket-example");
		expect(target.searchParams.get("state")).toBe("state-example");
		expect(
			await screen.findByText(copy.returnToTerminal),
		).toBeInTheDocument();
	});

	it("refuses a link without the CLI's port and state", () => {
		render(
			<ConnectChatgptPlanForm
				email="dev@example.com"
				organizations={ORGS}
				port={null}
				state={null}
			/>,
		);
		expect(screen.getByText(copy.invalidLink)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: copy.approve })).toBeNull();
	});
});
