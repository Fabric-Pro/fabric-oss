"use client";

import { useIsGuestInOrg } from "@saas/organizations/hooks/use-is-guest-in-org";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
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

	// Auto-detect home href based on organization context.
	// If explicitly provided, use that; otherwise use org-aware path.
	// Project-only guests fall back to the PERSONAL dashboard — their
	// Home crumb must never route into (or name) the host org.
	const effectiveHomeHref = homeHref ?? (isGuest ? "/app" : basePath);

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
					{items.length > 0 && <BreadcrumbSeparator />}
					{items.map((item, index) => {
						const isLast = index === items.length - 1;

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
