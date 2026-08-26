import { Card, CardContent } from "@ui/components/card";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { AiUsageActivityView } from "@saas/payments/components/AiUsageActivityView";
import { getOrganizationMembership } from "@repo/database";
import { XIcon } from "lucide-react";
import { notFound } from "next/navigation";

export const metadata = {
	title: "AI usage history",
};

export default async function OrgAiUsageSettingsPage({
	params,
}: {
	params: Promise<{ organizationSlug: string }>;
}) {
	const { organizationSlug } = await params;
	const [session, organization] = await Promise.all([
		getSession(),
		getActiveOrganization(organizationSlug),
	]);

	if (!organization) {
		return notFound();
	}

	// Server-side gate: org-wide AI Usage is owner/admin only. Resolve the
	// caller's membership role here so non-admins never mount the client view
	// and never fire the BE queries that would just return FORBIDDEN. The
	// procedures still enforce the same check (`requireOrganizationAdmin`)
	// — this is a UX optimization on top of the authoritative server gate,
	// not a replacement for it.
	const userId = session?.user?.id;
	const membership = userId
		? await getOrganizationMembership(organization.id, userId)
		: null;
	const role = membership?.role ?? null;
	const canView = role === "owner" || role === "admin";

	if (!canView) {
		return (
			<div className="flex flex-col gap-6">
				<header className="space-y-3">
					<div className="flex items-center gap-3">
						<span
							className="block h-3.5 w-0.5 shrink-0 bg-primary"
							aria-hidden="true"
						/>
						<p className="font-sans text-[11px] font-normal uppercase tracking-[0.25em] text-primary">
							AI Usage
						</p>
					</div>
					<h1 className="text-3xl leading-tight tracking-tight lg:text-4xl">
						{organization.name}
					</h1>
				</header>
				<Card className="border-destructive/30 bg-destructive/5">
					<CardContent className="flex flex-col items-start gap-3 p-6">
						<div className="flex items-center gap-2 text-sm font-semibold text-destructive">
							<XIcon className="size-4" />
							You don't have access to this organization's AI
							usage
						</div>
						<p className="max-w-2xl text-sm text-muted-foreground">
							Organization-wide AI activity is restricted to
							owners and admins of {organization.name}. Ask an
							admin to grant you the role to see this page.
						</p>
					</CardContent>
				</Card>
			</div>
		);
	}

	return (
		<AiUsageActivityView
			organizationId={organization.id}
			organizationName={organization.name}
		/>
	);
}
