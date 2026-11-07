import messages from "@repo/i18n/translations/en.json";
import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { DeliveryReportStarterPicker } from "../DeliveryReportStarterPicker";

vi.mock("next-intl", async () => {
	const { default: locale } = await import("@repo/i18n/translations/en.json");
	return {
		NextIntlClientProvider: ({ children }: { children: unknown }) =>
			children,
		useTranslations: (namespace: string) => (key: string) =>
			[namespace, ...key.split(".")].reduce(
				(value: any, part) => value[part],
				locale,
			),
	};
});

describe("delivery starter entry", () => {
	it("opens the existing report setup with a known starter, without creating or running work", () => {
		render(
			<NextIntlClientProvider locale="en" messages={messages}>
				<DeliveryReportStarterPicker reportBasePath="/app/example-org/report-templates" />
			</NextIntlClientProvider>,
		);
		expect(
			screen.getByRole("combobox", {
				name: "What would you like to create?",
			}),
		).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "Review report setup" }),
		).toHaveAttribute(
			"href",
			"/app/example-org/report-templates/new?starter=delivery-update",
		);
		expect(
			screen.getByText(/Nothing is created or run/),
		).toBeInTheDocument();
		fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
		fireEvent.click(
			screen.getByRole("option", { name: "Release readiness" }),
		);
		expect(
			screen.getByRole("link", { name: "Review report setup" }),
		).toHaveAttribute(
			"href",
			"/app/example-org/report-templates/new?starter=release-readiness",
		);
		expect(
			screen.getByRole("link", { name: "Browse saved reports" }),
		).toHaveAttribute("href", "/app/example-org/report-templates");
	});
});
