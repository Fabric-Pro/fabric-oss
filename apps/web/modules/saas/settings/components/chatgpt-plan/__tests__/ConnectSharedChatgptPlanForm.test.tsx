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

import { ConnectSharedChatgptPlanForm } from "../ConnectChatgptPlanForm";

const copy = en.settings.chatgptPlan.connectShared;
const connectCopy = en.settings.chatgptPlan.connect;
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

// Fizzy #2770: `fabric connect chatgpt --org <slug> --shared`.
describe("Connect a shared ChatGPT plan account", () => {
	it("approves for the named organization only and hands the ticket to the CLI", async () => {
		render(
			<ConnectSharedChatgptPlanForm
				organization={{ slug: "example-org", name: "Example Org" }}
				port={54321}
				state="state-example"
			/>,
		);
		expect(screen.getByText(/Example Org shares/)).toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", { name: connectCopy.approve }),
		);
		await waitFor(() => expect(assign).toHaveBeenCalled());
		expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
			shared: { organizationSlug: "example-org" },
		});
		const target = new URL(String(assign.mock.calls[0]?.[0]));
		expect(target.host).toBe("127.0.0.1:54321");
		expect(target.searchParams.get("ticket")).toBe("ticket-example");
		expect(target.searchParams.get("state")).toBe("state-example");
	});

	it("refuses an organization the person does not administer, and lets the CLI stop waiting", async () => {
		render(
			<ConnectSharedChatgptPlanForm
				organization={null}
				port={54321}
				state="state-example"
			/>,
		);
		expect(screen.getByText(copy.notAllowed)).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: connectCopy.approve }),
		).toBeNull();
		await userEvent.click(
			screen.getByRole("button", { name: connectCopy.close }),
		);
		const target = new URL(String(assign.mock.calls[0]?.[0]));
		expect(target.searchParams.get("error")).toBe(
			"chatgpt_plan_shared_not_allowed",
		);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("explains a link without the CLI's details", () => {
		render(
			<ConnectSharedChatgptPlanForm
				organization={{ slug: "example-org", name: "Example Org" }}
				port={null}
				state={null}
			/>,
		);
		expect(screen.getByText(copy.invalidLink)).toBeInTheDocument();
	});
});
