import { ProjectReadinessPanelSlot } from "@saas/projects/components/readiness/ProjectReadinessPanel";
import { ProjectReadinessProvider } from "@saas/projects/components/readiness/ProjectReadinessProvider";
import type { ReactNode } from "react";

/**
 * Personal-context project layout (Fizzy #2165).
 *
 * Readiness has to appear on every project page. A route-group layout is two
 * files rather than twenty-odd edits: it already wraps the tabbed project page
 * AND the standalone routes — the document editor, the feature workspace, a
 * single context, Security, Coding Agents, Weave, Publishing — none of which
 * render the tabbed shell.
 *
 * This renders the FALLBACK position — above everything, breadcrumb included —
 * which only applies to the standalone routes that have no title area of their
 * own. The tabbed project page claims a better slot beneath its title, and the
 * fallback stands down when it does. Either way the panel pushes page content
 * down rather than overlaying it, as the criteria require.
 */
export default async function PersonalProjectLayout({
	children,
	params,
}: {
	children: ReactNode;
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;

	return (
		<ProjectReadinessProvider projectId={id}>
			<ProjectReadinessPanelSlot />
			{children}
		</ProjectReadinessProvider>
	);
}
