import type { DeploymentItem } from "@repo/database";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DeploymentsPanel } from "../DeploymentsPanel";

function dep(overrides: Partial<DeploymentItem> = {}): DeploymentItem {
	return {
		occurredAt: new Date("2026-06-05T10:00:00Z"),
		title: "v1.2.0 — Refunds",
		repoFullName: "Fabric-Pro/fabric",
		tagName: "v1.2.0",
		releaseName: "v1.2.0 — Refunds",
		url: "https://github.com/Fabric-Pro/fabric/releases/tag/v1.2.0",
		author: "octocat",
		body: "## Notes\n- **bold** change",
		...overrides,
	};
}

describe("DeploymentsPanel", () => {
	it("renders nothing when empty and no failure", () => {
		const { container } = render(<DeploymentsPanel deployments={[]} />);
		expect(container.firstChild).toBeNull();
	});

	it("renders a release with tag, title, repo and link", () => {
		render(<DeploymentsPanel deployments={[dep()]} />);
		expect(screen.getByText("v1.2.0")).toBeInTheDocument();
		expect(screen.getByText("v1.2.0 — Refunds")).toBeInTheDocument();
		expect(screen.getByText(/Fabric-Pro\/fabric/)).toBeInTheDocument();
		const link = screen.getByRole("link");
		expect(link).toHaveAttribute(
			"href",
			"https://github.com/Fabric-Pro/fabric/releases/tag/v1.2.0",
		);
	});

	it("renders markdown body (bold → strong) once the notes are expanded", () => {
		render(<DeploymentsPanel deployments={[dep()]} />);
		// Body lives in a default-closed Collapsible — open it before asserting.
		fireEvent.click(screen.getByText("Release notes"));
		expect(screen.getByText("bold").tagName).toBe("STRONG");
	});

	it("shows a placeholder when a release has no notes", () => {
		render(<DeploymentsPanel deployments={[dep({ body: undefined })]} />);
		expect(
			screen.getByText(/No release notes provided/i),
		).toBeInTheDocument();
	});

	it("shows the sanitized reason banner when an error is present, even with no releases", () => {
		render(<DeploymentsPanel deployments={[]} error="o/r: down" />);
		expect(screen.getByText(/Note: o\/r: down/)).toBeInTheDocument();
		expect(
			screen.queryByText(/temporarily unavailable/i),
		).not.toBeInTheDocument();
	});

	it("surfaces the deploymentsError reason (not the old generic string)", () => {
		render(
			<DeploymentsPanel
				deployments={[]}
				error="3 release-note bodies omitted to stay within the brief size budget"
			/>,
		);
		expect(
			screen.getByText(/release-note bodies omitted/i),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/temporarily unavailable/i),
		).not.toBeInTheDocument();
	});

	it("collapses and caps a long/multiline reason", () => {
		const long = `line1\n${"y".repeat(500)}`;
		render(<DeploymentsPanel deployments={[]} error={long} />);
		const el = screen.getByText(/^Note:/);
		expect(el.textContent!.length).toBeLessThanOrEqual(307); // "Note: " + 300 + "…"
		expect(el.textContent).not.toContain("\n");
	});

	it("keeps the section truncation note visible even behind long per-repo errors", () => {
		// Mirrors applyDeploymentsResult ordering: section-level "*" note FIRST, then a
		// long per-repo failure that would otherwise eat the 300-char window.
		const error = `Deployments list truncated to 50 most recent; 12 older in-window release(s) omitted; o/r: ${"z".repeat(400)}`;
		render(<DeploymentsPanel deployments={[]} error={error} />);
		expect(screen.getByText(/truncated to 50/i)).toBeInTheDocument();
	});
});
