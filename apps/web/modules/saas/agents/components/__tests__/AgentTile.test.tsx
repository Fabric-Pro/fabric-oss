import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { registryStatus } from "../AgentCard";
import { AgentTile, frameworkLabel, kindLabel, scopeLabel } from "../AgentTile";

vi.mock("@ui/components/tooltip", () => ({
	Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
		<>{children}</>
	),
	TooltipContent: () => null,
	TooltipProvider: ({ children }: { children: React.ReactNode }) => (
		<>{children}</>
	),
}));

describe("AgentTile", () => {
	it("renders name, meta, description, chips, footer and scope", () => {
		render(
			<AgentTile
				name="Warp (Security Auditor)"
				description="Read-only security and spec compliance auditor."
				status={{ label: "Active", tone: "good" }}
				meta={["Vercel AI SDK", null, "Security"]}
				footer={["No runs yet", "4 minutes ago"]}
				scope="System"
				chips={["Web search", "Code search", "Files", "Memory"]}
			/>,
		);
		expect(screen.getByText("Warp (Security Auditor)")).toBeInTheDocument();
		expect(
			screen.getByText("Vercel AI SDK · Security"),
		).toBeInTheDocument();
		expect(
			screen.getByText("No runs yet · 4 minutes ago"),
		).toBeInTheDocument();
		expect(screen.getByText("System")).toBeInTheDocument();
		expect(screen.getByText("Web search")).toBeInTheDocument();
		expect(screen.getByText("+1")).toBeInTheDocument();
	});

	it("opens on click and on Enter", () => {
		const onOpen = vi.fn();
		render(
			<AgentTile
				name="Sidekick"
				status={{ label: "Active", tone: "good" }}
				onOpen={onOpen}
			/>,
		);
		const tile = screen.getByRole("button", { name: "Open Sidekick" });
		tile.click();
		expect(onOpen).toHaveBeenCalledTimes(1);
	});
});

describe("registryStatus", () => {
	it("calls a failed health probe Unreachable and keeps the reason", () => {
		const status = registryStatus({
			status: "ERROR",
			lastHealthError: "connect ECONNREFUSED 127.0.0.1:8124",
			lastHealthCheck: new Date(Date.now() - 60_000),
		});
		expect(status.label).toBe("Unreachable");
		expect(status.tone).toBe("bad");
		expect(status.detail).toContain("ECONNREFUSED");
		expect(status.detail).toContain("Checked");
	});

	it("maps the other registry states", () => {
		expect(registryStatus({ status: "ACTIVE" }).label).toBe("Active");
		expect(registryStatus({ status: "DEPLOYING" }).tone).toBe("busy");
		expect(registryStatus({ status: "MAINTENANCE" }).tone).toBe("warn");
		expect(registryStatus({ status: "WHATEVER" }).label).toBe("Inactive");
	});
});

describe("labels", () => {
	it("names frameworks and scopes for people", () => {
		expect(frameworkLabel("AI_SDK")).toBe("Vercel AI SDK");
		expect(frameworkLabel("LANGGRAPH")).toBe("LangGraph");
		expect(frameworkLabel("some_custom-thing")).toBe("Some Custom Thing");
		expect(frameworkLabel(null)).toBeNull();
		expect(scopeLabel("SYSTEM")).toBe("System");
		expect(scopeLabel("USER")).toBe("Personal");
		expect(scopeLabel("ORGANIZATION")).toBe("Organization");
		expect(kindLabel("SYSTEM")).toBe("Built-in");
		expect(kindLabel("ORGANIZATION")).toBe("Team");
		expect(kindLabel("USER")).toBe("Yours");
		expect(kindLabel("PERSONAL")).toBe("Yours");
	});
});
