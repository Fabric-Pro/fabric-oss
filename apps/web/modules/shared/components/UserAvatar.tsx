import { config } from "@repo/config";
import { getAvatarInitials } from "@shared/lib/avatar-initials";
import { Avatar, AvatarFallback, AvatarImage } from "@ui/components/avatar";
import { useMemo } from "react";

export const UserAvatar = ({
	name,
	avatarUrl,
	className,
	ref,
}: React.ComponentProps<typeof Avatar> & {
	name: string;
	avatarUrl?: string | null;
	className?: string;
}) => {
	const initials = useMemo(() => getAvatarInitials(name), [name]);

	const avatarSrc = useMemo(
		() =>
			avatarUrl
				? avatarUrl.startsWith("http")
					? avatarUrl
					: `/image-proxy/${config.storage.bucketNames.avatars}/${avatarUrl}`
				: undefined,
		[avatarUrl],
	);

	return (
		<Avatar ref={ref} className={className}>
			<AvatarImage src={avatarSrc} className="object-cover" />
			<AvatarFallback className="rounded-[inherit] bg-primary font-mono font-medium text-primary-foreground">
				{initials}
			</AvatarFallback>
		</Avatar>
	);
};

UserAvatar.displayName = "UserAvatar";
