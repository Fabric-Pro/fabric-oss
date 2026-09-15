import type { CustomerOutcomesDto } from "@repo/api/modules/outcomes/lib/customer-outcomes";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CustomerOutcomesView } from "../CustomerOutcomesView";

const fixture: CustomerOutcomesDto = {
	projectName: "Acme Portal",
	visionPurpose: "Help small businesses get paid faster.",
	visionCoreActions: ["send invoice", "collect payment"],
	visionCycle: "weekly",
	decisions: [
		{
			storyIdentifier: "F-7",
			storyTitle: "Instant payouts",
			decidedAt: new Date("2026-09-02T00:00:00Z"),
			summary: "Spike findings applied",
		},
	],
	demos: [
		{
			storyIdentifier: "F-7",
			title: "Instant payouts",
			frameShareUrl: "https://app.test/share/frame/pub-token",
		},
		{ storyIdentifier: "F-9", title: "Reminders" },
	],
	shipped: [
		{
			storyIdentifier: "F-7",
			storyTitle: "Instant payouts",
			mergedAt: new Date("2026-09-05T00:00:00Z"),
			pullRequestUrl: "https://github.com/acme/portal/pull/12",
		},
	],
	metrics: [
		{
			name: "Activation rate",
			direction: "UP",
			target: 50,
			lastValue: 41,
			previousValue: 38,
			lastObservedAt: new Date("2026-09-01T00:00:00Z"),
		},
		{
			name: "Support tickets",
			direction: "DOWN",
			target: null,
			lastValue: 12,
			previousValue: 9,
			lastObservedAt: null,
		},
	],
};

describe("CustomerOutcomesView", () => {
	it("renders the project vision and every section from the fixture", () => {
		render(<CustomerOutcomesView outcomes={fixture} />);

		expect(
			screen.getByRole("heading", { level: 1, name: "Acme Portal" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("Help small businesses get paid faster."),
		).toBeInTheDocument();
		expect(screen.getByText("send invoice")).toBeInTheDocument();
		expect(screen.getByText("weekly")).toBeInTheDocument();

		// metrics
		expect(screen.getByText("Activation rate")).toBeInTheDocument();
		expect(screen.getByText("41")).toBeInTheDocument();
		expect(screen.getByText("from 38")).toBeInTheDocument();
		expect(screen.getByText("Target 50")).toBeInTheDocument();
		expect(screen.getByText("Support tickets")).toBeInTheDocument();

		// shipped
		const pr = screen.getByRole("link", { name: "Instant payouts" });
		expect(pr).toHaveAttribute(
			"href",
			"https://github.com/acme/portal/pull/12",
		);

		// decisions
		expect(screen.getByText("Spike findings applied")).toBeInTheDocument();
	});

	it("links a demo only when a public frame URL is present", () => {
		render(<CustomerOutcomesView outcomes={fixture} />);
		const demoLinks = screen.getAllByRole("link", { name: "Open demo" });
		expect(demoLinks).toHaveLength(1);
		expect(demoLinks[0]).toHaveAttribute(
			"href",
			"https://app.test/share/frame/pub-token",
		);
		expect(screen.getByText("Shown on request")).toBeInTheDocument();
	});

	it("marks metrics that moved against their direction", () => {
		render(<CustomerOutcomesView outcomes={fixture} />);
		// Activation UP 38→41 = up (good); tickets DOWN 9→12 = up (bad)
		const trends = screen.getAllByText("up");
		expect(trends).toHaveLength(2);
		expect(trends[0]).toHaveClass("text-secondary");
		expect(trends[1]).toHaveClass("text-destructive");
	});

	it("renders empty states and no footer when embedded", () => {
		const { container } = render(
			<CustomerOutcomesView
				embedded
				outcomes={{
					...fixture,
					decisions: [],
					demos: [],
					shipped: [],
					metrics: [],
					visionPurpose: null,
					visionCoreActions: [],
					visionCycle: null,
				}}
			/>,
		);
		expect(screen.getByText("No metrics defined yet.")).toBeInTheDocument();
		expect(screen.getByText("Nothing merged yet.")).toBeInTheDocument();
		expect(screen.getByText("No accepted spikes yet.")).toBeInTheDocument();
		expect(
			screen.getByText("No decisions recorded yet."),
		).toBeInTheDocument();
		expect(container.querySelector("footer")).toBeNull();
	});
});
