"use client";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
export function CreatePromptMenu({
	path,
	returnTo,
}: {
	path: string;
	returnTo?: string;
}) {
	const router = useRouter();
	const { userRole } = useOrganizationContext();
	const canCreate = userRole === "owner" || userRole === "admin";
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					disabled={!canCreate}
					title={
						canCreate
							? undefined
							: "Organization owners and administrators can create shared prompts."
					}
					data-onboarding-target="prompts-new"
				>
					<PlusIcon className="size-4" />
					Create prompt
					<ChevronDownIcon className="size-4" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{[
					["conversation", "From conversation"],
					["scratch", "From scratch"],
					["existing", "From existing"],
				].map(([mode, label]) => (
					<DropdownMenuItem
						key={mode}
						onSelect={() => {
							const q = new URLSearchParams({ mode });
							if (returnTo) {
								q.set("returnTo", returnTo);
							}
							router.push(`${path}/new?${q}`);
						}}
					>
						{label}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
