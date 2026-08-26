/**
 * Page shell for the customer-facing health surface.
 *
 * Shared by the personal and organization routes so the two cannot drift in
 * copy or layout — the only thing that differs between them is which tenant the
 * procedure resolves from the session, which is decided server-side.
 *
 * Server component: the hero is static, and only the dashboard beneath it needs
 * client interactivity.
 */

import { SystemHealthDashboard } from "./SystemHealthDashboard";

export function SystemHealthPage() {
	return (
		<div className="relative">
			{/*
			  Dot-grid texture rather than an animated gradient hero, per the
			  design direction. Purely decorative, so it is hidden from assistive
			  technology.
			*/}
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-60"
				style={{
					backgroundImage:
						"radial-gradient(circle, color-mix(in oklab, var(--foreground) 13%, transparent) 1px, transparent 1px)",
					backgroundSize: "32px 32px",
					maskImage: "linear-gradient(to bottom, black, transparent)",
					WebkitMaskImage:
						"linear-gradient(to bottom, black, transparent)",
				}}
			/>
			<div className="relative space-y-8 py-8">
				<header className="max-w-2xl">
					<p className="app-editorial-label">Platform status</p>
					<h1 className="mt-3 font-normal font-serif text-4xl text-foreground leading-tight">
						System health
					</h1>
					<p className="mt-3 text-muted-foreground">
						Live status for the parts of Fabric your workspace
						depends on, so you can tell a platform problem from
						something on your side without waiting on support.
					</p>
				</header>
				<SystemHealthDashboard />
			</div>
		</div>
	);
}
