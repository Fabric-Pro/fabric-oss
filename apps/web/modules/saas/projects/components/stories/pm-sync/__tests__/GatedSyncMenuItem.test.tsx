/**
 * Per-item push/pull read against the Roadmap gates (Fizzy #2204, FR53/FR54).
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { ArrowUpIcon } from "lucide-react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => vi.fn());
vi.mock("../../../capability-gates/useCapabilityGates", () => ({
	useCapabilityGate: (key: string) => gate(key),
}));

import { GatedSyncMenuItem } from "../GatedSyncMenuItem";

const open = { gate: null, view: null, blocked: false, hidden: false };

function renderItem(direction: "push" | "pull") {
	const onActivate = vi.fn();
	render(
		<DropdownMenu defaultOpen>
			<DropdownMenuTrigger>menu</DropdownMenuTrigger>
			<DropdownMenuContent>
				<GatedSyncMenuItem
					direction={direction}
					icon={ArrowUpIcon}
					onActivate={onActivate}
				>
					Push to Jira
				</GatedSyncMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>,
	);
	return onActivate;
}

beforeEach(() => {
	gate.mockReset();
	gate.mockReturnValue(open);
});

describe("GatedSyncMenuItem", () => {
	it("reads sync-to-pm for a push and pull-from-pm for a pull", () => {
		renderItem("push");
		expect(gate).toHaveBeenCalledWith("roadmap.sync-to-pm");
		gate.mockClear();
		renderItem("pull");
		expect(gate).toHaveBeenCalledWith("roadmap.pull-from-pm");
	});

	it("gating off (no gate): runs as before", async () => {
		const user = userEvent.setup();
		const onActivate = renderItem("push");
		const item = screen.getByRole("menuitem", { name: /Push to Jira/ });
		expect(item).not.toHaveAttribute("aria-disabled");
		await user.click(item);
		expect(onActivate).toHaveBeenCalledTimes(1);
	});

	it("blocked (read-only): aria-disabled with the gate's title and body, and inert", async () => {
		gate.mockReturnValue({
			gate: {},
			view: {
				state: "HARD_BLOCK",
				title: "reason.roadmap.pm-read-only.title",
				body: "reason.roadmap.pm-read-only.body",
				params: { dependency: "" },
			},
			blocked: true,
			hidden: false,
		});
		const user = userEvent.setup();
		const onActivate = renderItem("push");
		const item = screen.getByRole("menuitem", { name: /Push to Jira/ });
		expect(item).toHaveAttribute("aria-disabled", "true");
		expect(
			screen.getByText("reason.roadmap.pm-read-only.title"),
		).toBeInTheDocument();
		expect(
			screen.getByText("reason.roadmap.pm-read-only.body"),
		).toBeInTheDocument();
		await user.click(item);
		expect(onActivate).not.toHaveBeenCalled();
	});

	it("a running sync shows Processing", () => {
		gate.mockReturnValue({
			gate: {},
			view: {
				state: "PROCESSING",
				title: "reason.roadmap.pm-sync-running.title",
				body: "reason.roadmap.pm-sync-running.body",
				params: { dependency: "" },
			},
			blocked: true,
			hidden: false,
		});
		renderItem("push");
		const item = screen.getByRole("menuitem", { name: /Push to Jira/ });
		expect(
			item.querySelector(".motion-safe\\:animate-spin"),
		).not.toBeNull();
		expect(item).toHaveTextContent("reason.roadmap.pm-sync-running.title");
	});
});
