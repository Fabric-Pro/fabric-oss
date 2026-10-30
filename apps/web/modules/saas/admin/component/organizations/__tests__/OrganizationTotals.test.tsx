vi.mock(
	"next-intl",
	async (original) => await original<typeof import("next-intl")>(),
);

import messages from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		admin: {
			hostedAdoption: {
				counts: {
					queryOptions: () => ({
						queryKey: ["hosted-adoption"],
						queryFn: query,
					}),
				},
			},
		},
	},
}));

import { OrganizationTotals } from "../OrganizationTotals";

afterEach(cleanup);
function show() {
	render(
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
			}
		>
			<NextIntlClientProvider locale="en" messages={messages}>
				<OrganizationTotals />
			</NextIntlClientProvider>
		</QueryClientProvider>,
	);
}
describe("OrganizationTotals", () => {
	it("renders labeled counts", async () => {
		query.mockResolvedValue({ organizations: 2, projects: 4, users: 3 });
		show();
		for (const label of ["Organizations", "Projects", "User accounts"]) {
			expect(screen.getByText(label)).toBeInTheDocument();
		}
		for (const value of ["2", "4", "3"]) {
			expect(await screen.findByText(value)).toBeInTheDocument();
		}
	});
	it("renders all zero counts", async () => {
		query.mockResolvedValue({ organizations: 0, projects: 0, users: 0 });
		show();
		expect(await screen.findAllByText("0")).toHaveLength(3);
	});
	it("shows loading skeletons", () => {
		query.mockImplementation(() => new Promise(() => {}));
		show();
		const statuses = screen.getAllByRole("status");
		expect(statuses).toHaveLength(3);
		for (const [index, label] of [
			"Organizations",
			"Projects",
			"User accounts",
		].entries()) {
			expect(statuses[index]).toHaveTextContent(`Loading ${label}…`);
		}
	});
	it("keeps block loading markup outside paragraphs in server HTML", () => {
		query.mockImplementation(() => new Promise(() => {}));
		const html = renderToString(
			<QueryClientProvider client={new QueryClient()}>
				<NextIntlClientProvider locale="en" messages={messages}>
					<OrganizationTotals />
				</NextIntlClientProvider>
			</QueryClientProvider>,
		);
		expect(html).not.toMatch(/<p\b[^>]*>\s*<div\b/);
	});

	it("shows a generic error", async () => {
		query.mockRejectedValue(new Error("example failure"));
		show();
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Unable to load data.",
		);
	});
});
