"use client";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	ChevronDownIcon,
	FilePlusIcon,
	ImportIcon,
	MessagesSquareIcon,
	PlusIcon,
} from "lucide-react";
import Link from "next/link";
export function SkillsCreateMenu({
	basePath,
	onImport,
	disabled = false,
}: {
	basePath: string;
	onImport: () => void;
	disabled?: boolean;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					size="sm"
					disabled={disabled}
					data-onboarding-target="skills-new"
				>
					<PlusIcon className="size-4" />
					Create skill
					<ChevronDownIcon className="size-4" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem asChild>
					<Link href={`${basePath}/skills/new?mode=conversation`}>
						<MessagesSquareIcon className="size-4" />
						From conversation
					</Link>
				</DropdownMenuItem>
				<DropdownMenuItem asChild>
					<Link href={`${basePath}/skills/new`}>
						<FilePlusIcon className="size-4" />
						From scratch
					</Link>
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={onImport}>
					<ImportIcon className="size-4" />
					From existing
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
