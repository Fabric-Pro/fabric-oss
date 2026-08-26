"use client";

/**
 * DefaultMcpStatusCard
 *
 * Renders inside an assistant turn when the orchestrator workflow emitted
 * a structured CTA payload describing the status of a default-enabled MCP
 * server (Excalidraw in v1; future entries — Mermaid, etc. — reuse the
 * same component).
 *
 * Two states are supported via the `kind` discriminator on the payload:
 *
 * 1. `"connection-needed"` — the tenant has no `MCPConfig` row for the
 *    server. Renders the connect-CTA card with a link to the MCP servers
 *    page (legacy behavior; functionally unreachable for Excalidraw after
 *    the backfill, but retained for safety + future opt-in
 *    default-enabled servers). Preserves the legacy
 *    `data-testid="connect-excalidraw-card"` for the Excalidraw branch so
 *    the existing E2E (`nexus-excalidraw-routing.spec.ts` scenario 2)
 *    remains green without an assertion change.
 *
 * 2. `"service-down"` — the eager-load path failed (no-config,
 *    server-unreachable, schema-mismatch, or tool-call error). Renders
 *    the same frame with parameterized title/body from the payload and
 *    no primary action. The discriminated-union type forbids a
 *    `primaryAction` from sneaking onto the service-down branch at
 *    compile time (no inline retry button in v1).
 *
 * Copy strings are part of the contract — the workflow stamps title /
 * body / primaryAction onto the structured-CTA payload and the unit
 * tests assert exact strings; do not change them without coordinating
 * with the workflow side (`packages/temporal/src/workflows/orchestrator/
 * phases/iterative-execution.ts`) and the E2E specs.
 *
 * Tokens only — no hardcoded hex, per `CLAUDE.md` design principles.
 */

import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import { AlertTriangleIcon, Plug2 } from "lucide-react";
import Link from "next/link";

/**
 * Structured CTA payload emitted by the workflow when a default-enabled
 * MCP server cannot be eager-loaded — either because the tenant has no
 * configured `MCPConfig` row (`connection-needed`) or because the eager-
 * load step failed (`service-down`). The workflow stamps this exact
 * shape onto the synthetic tool-call result so the frontend dispatcher
 * can detect and render it via {@link DefaultMcpStatusCard}.
 *
 * The two `kind` variants enforce, at the type level, that the
 * `service-down` branch carries no `primaryAction` (no inline retry in
 * v1). Adding `primaryAction` to a `service-down` payload is a
 * TypeScript error.
 */
export type DefaultMcpStatusCtaPayload =
	| {
			type: "structured_cta";
			kind: "connection-needed";
			serverKey: string;
			serverName: string;
			title: string;
			body: string;
			primaryAction: {
				label: string;
				href: string;
			};
	  }
	| {
			type: "structured_cta";
			kind: "service-down";
			serverKey: string;
			serverName: string;
			title: string;
			body: string;
			// No `primaryAction` in v1 — no inline retry button. The user
			// re-issues the prompt; the discriminated union forbids a
			// retry button slipping in here.
	  };

/**
 * Type guard — returns `true` when an arbitrary tool-result payload is
 * the structured CTA shape consumable by {@link DefaultMcpStatusCard}.
 * The dispatcher uses this to pick this card instead of the default
 * tool-result rendering.
 */
export function isDefaultMcpStatusCta(
	value: unknown,
): value is DefaultMcpStatusCtaPayload {
	if (!value || typeof value !== "object") {
		return false;
	}
	const v = value as Record<string, unknown>;
	if (v.type !== "structured_cta") {
		return false;
	}
	if (v.kind !== "connection-needed" && v.kind !== "service-down") {
		return false;
	}
	if (
		typeof v.serverKey !== "string" ||
		typeof v.serverName !== "string" ||
		typeof v.title !== "string" ||
		typeof v.body !== "string"
	) {
		return false;
	}
	if (v.kind === "connection-needed") {
		const action = v.primaryAction as
			| { label?: unknown; href?: unknown }
			| undefined;
		return (
			!!action &&
			typeof action.label === "string" &&
			typeof action.href === "string"
		);
	}
	// kind === "service-down" — no `primaryAction` permitted.
	return true;
}

interface DefaultMcpStatusCardProps {
	payload: DefaultMcpStatusCtaPayload;
}

export function DefaultMcpStatusCard({ payload }: DefaultMcpStatusCardProps) {
	// Legacy testid preserved for the Excalidraw connection-needed branch
	// so the existing Playwright scenario (`nexus-excalidraw-routing.spec
	// .ts` scenario 2) remains green without an assertion change. All
	// other branches get the generic testid plus a kind/serverKey-scoped
	// secondary testid for new scenarios.
	const legacyTestId =
		payload.kind === "connection-needed" &&
		payload.serverKey === "excalidraw"
			? "connect-excalidraw-card"
			: "default-mcp-status-card";
	const scopedTestId = `default-mcp-status-${payload.kind}-${payload.serverKey}`;

	if (payload.kind === "service-down") {
		return (
			<Card
				data-testid={legacyTestId}
				className="border-border bg-muted/40"
			>
				<CardHeader className="pb-2">
					<div className="flex items-center gap-2">
						<div className="flex h-8 w-8 items-center justify-center rounded-full bg-destructive/10">
							<AlertTriangleIcon
								className="h-4 w-4 text-destructive"
								aria-hidden="true"
							/>
						</div>
						<CardTitle className="text-base font-medium">
							{payload.title}
						</CardTitle>
					</div>
				</CardHeader>
				<CardContent>
					<CardDescription
						data-testid={scopedTestId}
						className="text-sm text-muted-foreground"
					>
						{payload.body}
					</CardDescription>
				</CardContent>
			</Card>
		);
	}

	// kind === "connection-needed" — existing copy + CTA. After the
	// Excalidraw backfill this branch is unreachable for Excalidraw
	// itself, but the dispatch is retained for safety and for future
	// opt-in default-enabled servers (Mermaid, etc.).
	return (
		<Card data-testid={legacyTestId} className="border-border bg-muted/40">
			<CardHeader className="pb-2">
				<div className="flex items-center gap-2">
					<div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
						<Plug2
							className="h-4 w-4 text-primary"
							aria-hidden="true"
						/>
					</div>
					<CardTitle className="text-base font-medium">
						{payload.title}
					</CardTitle>
				</div>
			</CardHeader>
			<CardContent className="space-y-3">
				<CardDescription
					data-testid={scopedTestId}
					className="text-sm text-muted-foreground"
				>
					{payload.body}
				</CardDescription>
				<Button asChild variant="default" size="sm">
					<Link href={payload.primaryAction.href}>
						{payload.primaryAction.label}
					</Link>
				</Button>
			</CardContent>
		</Card>
	);
}
