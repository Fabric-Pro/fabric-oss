/**
 * A ChatGPT plan's subscription as its sign-in reports it (Fizzy #2770 G7):
 * the tier badge, "Paid until", a warning for Free plans, and a warning when
 * the subscription runs out within three days or already has.
 */
import en from "@repo/i18n/translations/en.json";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () => vi.importActual("next-intl"));

import { ChatgptPlanSubscription } from "../ChatgptPlanSubscription";

const copy = en.settings.chatgptPlan.subscription;
const NOW = Date.parse("2026-10-09T12:00:00Z");
const DAY = 24 * 60 * 60_000;

function show(props: Parameters<typeof ChatgptPlanSubscription>[0]) {
	return render(
		<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
			<ChatgptPlanSubscription now={NOW} {...props} />
		</NextIntlClientProvider>,
	);
}

const day = (ms: number) =>
	new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
		new Date(ms),
	);

describe("ChatgptPlanSubscription", () => {
	it("shows the tier and when it is paid until", () => {
		show({
			tier: "PLUS",
			subscriptionActiveUntil: new Date(NOW + 20 * DAY),
		});
		expect(screen.getByText(copy.tier.PLUS)).toBeInTheDocument();
		expect(
			screen.getByText(`Paid until ${day(NOW + 20 * DAY)}`),
		).toBeInTheDocument();
		expect(screen.queryByText(copy.freeWarning)).toBeNull();
	});

	it("warns that a Free plan has very small limits", () => {
		show({ tier: "FREE", subscriptionActiveUntil: null });
		expect(screen.getByText(copy.tier.FREE)).toBeInTheDocument();
		expect(screen.getByText(copy.freeWarning)).toBeInTheDocument();
	});

	it("warns when the subscription runs out within three days, or has", () => {
		const { unmount } = show({
			tier: "PRO",
			subscriptionActiveUntil: new Date(NOW + 2 * DAY),
		});
		expect(
			screen.getByText(
				`Paid until ${day(NOW + 2 * DAY)}: runs out within 3 days`,
			),
		).toBeInTheDocument();
		unmount();
		show({ tier: "PRO", subscriptionActiveUntil: new Date(NOW - DAY) });
		expect(
			screen.getByText(
				`Subscription ended ${day(NOW - DAY)}: renew it in ChatGPT`,
			),
		).toBeInTheDocument();
	});

	it("shows nothing it does not know", () => {
		show({ tier: "UNKNOWN", subscriptionActiveUntil: null });
		expect(
			screen.getByTestId("chatgpt-plan-subscription").textContent,
		).toBe("");
	});
});
