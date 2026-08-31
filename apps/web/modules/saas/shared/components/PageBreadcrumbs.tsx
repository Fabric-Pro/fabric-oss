"use client";

import { useIsGuestInOrg } from "@saas/organizations/hooks/use-is-guest-in-org";
import {
	useAccountBasePath,
	useOrganizationContext,
} from "@saas/organizations/hooks/use-organization-context";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@ui/components/breadcrumb";
import { HomeIcon } from "lucide-react";

type BreadcrumbItemType = {
	label: string;
	href?: string;
};

type PageBreadcrumbsProps = {
	items: BreadcrumbItemType[];
	homeHref?: string;
	className?: string;
};

export function PageBreadcrumbs({
	items,
	homeHref,
	className,
}: PageBreadcrumbsProps) {
	const { basePath } = useOrganizationContext();
	const isGuest = useIsGuestInOrg();
	const ownBasePath = useAccountBasePath();

	// Auto-detect home href based on organization context.
	// If explicitly provided, use that; otherwise use org-aware path.
	// A project-only guest's Home crumb must never route into (or name) the
	// host org. It used to point at the personal dashboard; that is gone, and
	// every account has an organization now, so it points at their own.
	const effectiveHomeHref = homeHref ?? (isGuest ? ownBasePath : basePath);

	// Twenty-three pages open their trail with the host organization's NAME
	// linked to its root. For a guest that is the one thing their chrome must
	// never carry, and only the projects page had thought to drop it — so a
	// guest who reached any of the other twenty-two read the host's name at the
	// top of the page. Found by walking the app as a guest, not by reading it.
	//
	// Dropped centrally rather than in twenty-three call sites, because it is
	// one rule and belongs where the guest is already known. The crumb is
	// identified by where it points, which is the same value in all of them,
	// rather than by matching a name.
	//
	// The guest flag is seeded by the organization layout, so this holds during
	// server rendering too: no render of the trail ever paints the name.
	//
	// It does still travel in the serialized payload, both as this component's
	// props and — independently of breadcrumbs — as the active-organization
	// object the layout prefetches for the guest's own project access. So this
	// is a rule about what a guest is SHOWN, which is what the requirement
	// asks; it is not a confidentiality boundary, and filtering server-side
	// would not make it one while the layout seeds that object.
	const visibleItems =
		isGuest && basePath
			? items.filter((item) => item.href !== basePath)
			: items;

	return (
		<div className={className}>
			<Breadcrumb>
				<BreadcrumbList>
					<BreadcrumbItem>
						<BreadcrumbLink
							href={effectiveHomeHref}
							className="text-sm flex items-center gap-1.5"
						>
							<HomeIcon className="size-4" />
							Home
						</BreadcrumbLink>
					</BreadcrumbItem>
					{visibleItems.length > 0 && <BreadcrumbSeparator />}
					{visibleItems.map((item, index) => {
						const isLast = index === visibleItems.length - 1;

						return (
							<div
								key={index}
								className="flex items-center gap-1.5"
							>
								<BreadcrumbItem>
									{isLast || !item.href ? (
										<BreadcrumbPage className="text-sm">
											{item.label}
										</BreadcrumbPage>
									) : (
										<BreadcrumbLink
											href={item.href}
											className="text-sm"
										>
											{item.label}
										</BreadcrumbLink>
									)}
								</BreadcrumbItem>
								{!isLast && <BreadcrumbSeparator />}
							</div>
						);
					})}
				</BreadcrumbList>
			</Breadcrumb>
		</div>
	);
}
