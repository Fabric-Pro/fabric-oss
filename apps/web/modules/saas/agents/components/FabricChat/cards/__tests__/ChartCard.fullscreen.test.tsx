import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { Legend, Pie, Tooltip } from "recharts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChartCard } from "../ChartCard";
import type { ChartArtifact } from "../chart-artifact";

vi.mock("recharts", () => {
	const Chart = ({ children }: { children?: ReactNode }) => (
		<div>{children}</div>
	);
	return {
		ResponsiveContainer: ({
			children,
			width,
			height,
		}: {
			children?: ReactNode;
			width: number | string;
			height: number | string;
		}) => (
			<div
				data-testid="chart-size"
				data-width={width}
				data-height={height}
			>
				{children}
			</div>
		),
		Area: Chart,
		AreaChart: Chart,
		Bar: Chart,
		BarChart: Chart,
		CartesianGrid: Chart,
		Cell: Chart,
		Legend: vi.fn(Chart),
		Line: Chart,
		LineChart: Chart,
		Pie: vi.fn(Chart),
		PieChart: Chart,
		Scatter: Chart,
		ScatterChart: Chart,
		Tooltip: vi.fn(Chart),
		XAxis: Chart,
		YAxis: Chart,
	};
});

const artifact: ChartArtifact = {
	type: "chart",
	id: "example-chart",
	chartType: "bar",
	data: [{ category: "Example", value: 7 }],
	config: { xAxis: "category", yAxis: "value", title: "Example chart" },
};

let dimensions = { width: 0, height: 0 };
let observers: TestResizeObserver[] = [];
class TestResizeObserver implements ResizeObserver {
	element: Element | null = null;
	constructor(private callback: ResizeObserverCallback) {
		observers.push(this);
	}
	observe = (element: Element) => {
		this.element = element;
	};
	unobserve = vi.fn();
	disconnect = vi.fn();
	resize() {
		this.callback([], this);
	}
}

beforeEach(() => {
	vi.clearAllMocks();
	dimensions = { width: 0, height: 0 };
	observers = [];
	vi.stubGlobal("ResizeObserver", TestResizeObserver);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
		() => new DOMRect(0, 0, dimensions.width, dimensions.height),
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("fullscreen chart dimensions", () => {
	it("waits for its real host, tracks resize, and disconnects on close", () => {
		render(<ChartCard artifact={artifact} />);
		fireEvent.click(
			screen.getByRole("button", { name: "View fullscreen" }),
		);
		const dialog = screen.getByRole("dialog", { name: "Example chart" });
		expect(dialog).toHaveAccessibleDescription(
			"Expanded chart. Resize the window to adjust the view.",
		);
		expect(within(dialog).queryByTestId("chart-size")).toBeNull();
		const observer = observers.find(
			(item) => item.element?.className === "h-full w-full",
		);
		expect(observer).toBeDefined();
		if (!observer) {
			throw new Error("Fullscreen chart was not observed");
		}
		dimensions = { width: 640, height: 400 };
		act(() => observer.resize());
		expect(within(dialog).getByTestId("chart-size")).toHaveAttribute(
			"data-width",
			"640",
		);
		expect(within(dialog).getByTestId("chart-size")).toHaveAttribute(
			"data-height",
			"400",
		);
		dimensions = { width: 278, height: 508 };
		act(() => observer.resize());
		expect(within(dialog).getByTestId("chart-size")).toHaveAttribute(
			"data-width",
			"278",
		);
		expect(within(dialog).getByTestId("chart-size")).toHaveAttribute(
			"data-height",
			"508",
		);
		fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(observer.disconnect).toHaveBeenCalledOnce();
		expect(screen.getByTestId("chart-size")).toHaveAttribute(
			"data-height",
			"300",
		);
	});

	it.each(["Escape", "Close"])(
		"returns focus to the exact chart opener after %s",
		async (closeMethod) => {
			render(
				<>
					<ChartCard artifact={artifact} />
					<ChartCard
						artifact={{
							...artifact,
							id: "second-chart",
							config: {
								...artifact.config,
								title: "Second chart",
							},
						}}
					/>
				</>,
			);
			const openers = screen.getAllByRole("button", {
				name: "View fullscreen",
			});
			for (const [index, opener] of openers.entries()) {
				opener.focus();
				fireEvent.click(opener);
				const dialog = screen.getByRole("dialog", {
					name: index === 0 ? "Example chart" : "Second chart",
				});
				expect(screen.getAllByRole("dialog")).toHaveLength(1);
				if (closeMethod === "Escape") {
					fireEvent.keyDown(dialog, { key: "Escape" });
				} else {
					fireEvent.click(
						within(dialog).getByRole("button", { name: "Close" }),
					);
				}
				await waitFor(() => {
					expect(screen.queryByRole("dialog")).toBeNull();
					expect(opener).toHaveFocus();
				});
			}
		},
	);

	it("names the collapse action and preserves the chart when expanded again", () => {
		render(<ChartCard artifact={artifact} />);
		const collapse = screen.getByRole("button", { name: "Collapse chart" });
		expect(collapse).toHaveAttribute("aria-expanded", "true");
		fireEvent.click(collapse);
		expect(screen.queryByTestId("chart-size")).toBeNull();
		const expand = screen.getByRole("button", { name: "Expand chart" });
		expect(expand).toHaveAttribute("aria-expanded", "false");
		fireEvent.click(expand);
		expect(screen.getByTestId("chart-size")).toHaveAttribute(
			"data-height",
			"300",
		);
	});

	it("uses mobile touch targets without enlarging desktop toolbar controls", () => {
		const title = "Synthetic stakeholder communications draft";
		render(
			<ChartCard
				artifact={{
					...artifact,
					config: { ...artifact.config, title },
					metadata: { totalValue: 23 },
				}}
			/>,
		);
		expect(screen.getByText(title)).toBeInTheDocument();
		expect(screen.getByText("(23 total)")).toBeInTheDocument();
		for (const name of [
			"Download data as CSV",
			"View fullscreen",
			"Collapse chart",
		]) {
			expect(screen.getByRole("button", { name })).toHaveClass(
				"size-11",
				"sm:size-7",
			);
		}
	});
});

describe("pie chart labels", () => {
	it.each([
		{ category: "A", showLegend: true },
		{ category: "A", showLegend: false },
		{ category: "Copper Finch release review checklist", showLegend: true },
		{
			category: "Copper Finch release review checklist",
			showLegend: false,
		},
	])(
		"keeps percentages compact and full category data ($category, legend=$showLegend)",
		async ({ category, showLegend }) => {
			const pieArtifact: ChartArtifact = {
				...artifact,
				chartType: "pie",
				data: [
					{ category, value: 7 },
					{ category: "B", value: 11 },
					{ category: "C", value: 5 },
				],
				config: { ...artifact.config, showLegend },
			};
			const card = render(<ChartCard artifact={pieArtifact} />);
			const pieProps = vi.mocked(Pie).mock.calls[0]?.[0];
			const legendProps = vi.mocked(Legend).mock.calls[0]?.[0];
			const tooltipProps = vi.mocked(Tooltip).mock.calls[0]?.[0];
			expect(Boolean(legendProps)).toBe(showLegend);
			expect(pieProps?.data).toEqual(pieArtifact.data);
			expect(pieProps?.nameKey).toBe("category");
			expect(pieProps?.dataKey).toBe("value");
			if (!pieProps || !tooltipProps) {
				throw new Error("Pie chart and tooltip were not rendered");
			}
			card.unmount();
			const actual =
				await vi.importActual<typeof import("recharts")>("recharts");
			const chart = render(
				<actual.PieChart width={640} height={400}>
					<actual.Pie {...pieProps} isAnimationActive={false} />
					{legendProps && <actual.Legend {...legendProps} />}
					<actual.Tooltip
						{...tooltipProps}
						active
						defaultIndex={0}
						isAnimationActive={false}
					/>
				</actual.PieChart>,
			);
			await waitFor(() => {
				expect(
					Array.from(
						chart.container.querySelectorAll(
							".recharts-pie-label-text",
						),
						(label) => label.textContent,
					),
				).toEqual(["30%", "48%", "22%"]);
			});
			if (showLegend) {
				expect(
					chart.getByText(category, {
						selector: ".recharts-legend-item-text",
					}),
				).toBeInTheDocument();
			} else {
				expect(
					chart.container.querySelector(".recharts-legend-wrapper"),
				).toBeNull();
			}
			expect(
				await chart.findByText(category, {
					selector: ".recharts-tooltip-item-name",
				}),
			).toBeInTheDocument();
			expect(
				chart.getByText("7", {
					selector: ".recharts-tooltip-item-value",
				}),
			).toBeInTheDocument();
		},
	);
});
