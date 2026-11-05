"use client";

import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { useRef } from "react";
import { SkillViewLoader } from "./SkillViewLoader";

export function SkillDetailsSheet({
	skillId,
	onClose,
	returnTo,
}: {
	skillId: string;
	onClose: () => void;
	returnTo: string;
}) {
	const title = useRef<HTMLHeadingElement>(null);
	const returnFocus = useRef(
		typeof document === "undefined"
			? null
			: (document.activeElement as HTMLElement | null),
	);
	return (
		<Sheet
			open
			onOpenChange={(open) => {
				if (!open) {
					onClose();
				}
			}}
		>
			<SheetContent
				className="flex w-full flex-col gap-0 p-0 sm:max-w-3xl"
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					title.current?.focus();
				}}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					if (
						returnFocus.current?.isConnected &&
						returnFocus.current !== document.body
					) {
						returnFocus.current.focus();
						return;
					}
					document
						.querySelector<HTMLInputElement>(
							'input[placeholder="Search skills…"]',
						)
						?.focus();
				}}
			>
				<SheetHeader className="shrink-0 border-b border-border px-6 py-4 pr-12 text-left">
					<SheetTitle ref={title} tabIndex={-1}>
						Skill details
					</SheetTitle>
					<SheetDescription>
						Review instructions, files, and availability. Open Edit
						to make changes.
					</SheetDescription>
				</SheetHeader>
				<div className="no-scrollbar min-h-0 flex-1 overflow-y-auto p-6">
					<SkillViewLoader
						skillId={skillId}
						embedded
						returnTo={returnTo}
						onDeleted={onClose}
					/>
				</div>
			</SheetContent>
		</Sheet>
	);
}
