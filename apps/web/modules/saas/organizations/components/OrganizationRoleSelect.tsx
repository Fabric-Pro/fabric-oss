import type { OrganizationMemberRole } from "@repo/auth";
import { useOrganizationMemberRoles } from "@saas/organizations/hooks/member-roles";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";

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
	const organizationMemberRoles = useOrganizationMemberRoles();

	const roleOptions = Object.entries(organizationMemberRoles)
		.map(([value, label]) => ({
			value,
			label,
		}))
		.filter(
			(option) =>
				!excludeRoles?.includes(option.value as OrganizationMemberRole),
		);

	return (
		<Select value={value} onValueChange={onSelect} disabled={disabled}>
			<SelectTrigger>
				<SelectValue />
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
