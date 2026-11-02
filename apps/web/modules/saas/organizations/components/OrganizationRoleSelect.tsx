import type { OrganizationMemberRole } from "@repo/auth";
import { useOrganizationMemberRoles } from "@saas/organizations/hooks/member-roles";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { useTranslations } from "next-intl";

export function OrganizationRoleSelect({
	value,
	onSelect,
	disabled,
	excludeRoles,
}: {
	value: OrganizationMemberRole;
	onSelect: (value: OrganizationMemberRole) => void;
	disabled?: boolean;
	excludeRoles?: OrganizationMemberRole[];
}) {
	const t = useTranslations();
	const organizationMemberRoles = useOrganizationMemberRoles();

	const roleOptions = Object.entries(organizationMemberRoles)
		.map(([value, label]) => ({
			value,
			label,
		}))
		.filter(
			// The current value always stays: Radix renders an empty trigger for
			// a value no option matches, so excluding it would blank the row.
			(option) =>
				option.value === value ||
				!excludeRoles?.includes(option.value as OrganizationMemberRole),
		);
	const hasKnownRole = roleOptions.some((option) => option.value === value);

	return (
		<Select
			value={hasKnownRole ? value : ""}
			onValueChange={onSelect}
			disabled={disabled}
		>
			<SelectTrigger>
				<SelectValue placeholder={t("organizations.roles.none")} />
			</SelectTrigger>
			<SelectContent>
				{roleOptions.map((option) => (
					<SelectItem key={option.value} value={option.value}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
