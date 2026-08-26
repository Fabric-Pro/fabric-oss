"use client";

import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { organizationListQueryKey } from "@saas/organizations/lib/api";
import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

// Available brand colors - must match the server-side validation
const brandColors = [
	{ id: "teal", name: "Teal", class: "bg-teal-500" },
	{ id: "blue", name: "Blue", class: "bg-blue-500" },
	{ id: "purple", name: "Purple", class: "bg-purple-500" },
	{ id: "pink", name: "Pink", class: "bg-pink-500" },
	{ id: "orange", name: "Orange", class: "bg-orange-500" },
	{ id: "green", name: "Green", class: "bg-green-500" },
	{ id: "red", name: "Red", class: "bg-red-500" },
	{ id: "indigo", name: "Indigo", class: "bg-indigo-500" },
] as const;

type BrandColor = (typeof brandColors)[number]["id"];

export function OrganizationBrandColorForm() {
	const t = useTranslations("tooltips.projectSettings");
	const router = useRouter();
	const queryClient = useQueryClient();
	const { activeOrganization, refetchActiveOrganization } =
		useActiveOrganization();

	// Fetch current brand color
	const { data: brandColorData } = useQuery({
		queryKey: ["organization", activeOrganization?.id, "brandColor"],
		queryFn: async () => {
			if (!activeOrganization?.id) {
				return null;
			}
			const result = await orpc.organizations.brandColor.get.call({
				organizationId: activeOrganization.id,
			});
			return result.brandColor;
		},
		enabled: !!activeOrganization?.id,
	});

	// Update brand color mutation
	const updateBrandColorMutation = useMutation({
		mutationFn: async (brandColor: BrandColor | null) => {
			if (!activeOrganization?.id) {
				throw new Error("No active organization");
			}
			return await orpc.organizations.brandColor.update.call({
				organizationId: activeOrganization.id,
				brandColor,
			});
		},
		onSuccess: () => {
			toast.success("Brand color updated successfully");
			queryClient.invalidateQueries({
				queryKey: [
					"organization",
					activeOrganization?.id,
					"brandColor",
				],
			});
			queryClient.invalidateQueries({
				queryKey: organizationListQueryKey,
			});
			refetchActiveOrganization();
			router.refresh();
		},
		onError: () => {
			toast.error("Failed to update brand color");
		},
	});

	if (!activeOrganization) {
		return null;
	}

	const currentColor = brandColorData || "red";

	return (
		<SettingsItem
			title="Dashboard Theme Color"
			description="Choose a brand color to personalize your organization's dashboard appearance."
		>
			<div className="flex flex-wrap gap-3">
				{brandColors.map((color) => (
					// The `sr-only` child already names this swatch, so no
					// `aria-label` here — it would replace that name. The tooltip
					// only says what picking the swatch does.
					<Tooltip key={color.id}>
						<TooltipTrigger asChild>
							<button
								type="button"
								onClick={() =>
									updateBrandColorMutation.mutate(color.id)
								}
								disabled={updateBrandColorMutation.isPending}
								className={cn(
									"group relative size-10 rounded-full transition-all duration-200",
									color.class,
									"hover:scale-110 hover:shadow-lg",
									"focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-background",
									currentColor === color.id &&
										"ring-2 ring-offset-2 ring-offset-background ring-foreground",
								)}
							>
								{currentColor === color.id && (
									<span className="absolute inset-0 flex items-center justify-center">
										<svg
											className="size-5 text-white drop-shadow-md"
											fill="none"
											viewBox="0 0 24 24"
											stroke="currentColor"
											strokeWidth={3}
											aria-hidden="true"
										>
											<path
												strokeLinecap="round"
												strokeLinejoin="round"
												d="M5 13l4 4L19 7"
											/>
										</svg>
									</span>
								)}
								<span className="sr-only">{color.name}</span>
							</button>
						</TooltipTrigger>
						<TooltipContent>
							{t("brandColorSwatch", { color: color.name })}
						</TooltipContent>
					</Tooltip>
				))}
			</div>
			<p className="mt-3 text-muted-foreground text-sm">
				This color will be used for the animated gradient background on
				your dashboard.
			</p>
		</SettingsItem>
	);
}
