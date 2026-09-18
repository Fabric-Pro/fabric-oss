import { CapabilityGatesProvider } from "@saas/projects/components/capability-gates/useCapabilityGates";
import { ProjectReadinessPanelSlot } from "@saas/projects/components/readiness/ProjectReadinessPanel";
import { ProjectReadinessProvider } from "@saas/projects/components/readiness/ProjectReadinessProvider";
import type { ReactNode } from "react";

/**
 * Organization-context project layout (Fizzy #2165).
 *
 * Mirror of the personal-context layout. Both route trees need their own file —
 * they are separate route groups, so neither inherits the other's layout.
 * See the personal layout for why this lives here rather than in the header.
 */
export default async function OrganizationProjectLayout({
	children,
	params,
}: {
	children: ReactNode;
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;

	return (
		<ProjectReadinessProvider projectId={id}>
			{/*
			 * Capability gating resolves once here, for the whole project
			 * (Fizzy #1930). Every gated surface is a tab inside this route, so
			 * one provider covers all of them and the matrix is fetched once
			 * per project page rather than once per surface.
			 */}
			<CapabilityGatesProvider projectId={id}>
				<ProjectReadinessPanelSlot />
				{children}
			</CapabilityGatesProvider>
		</ProjectReadinessProvider>
	);
}
