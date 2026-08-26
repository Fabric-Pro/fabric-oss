import type { PropsWithChildren } from "react";

export function SettingsList({ children }: PropsWithChildren) {
	// `mt-4` adds breathing room between the SettingsHero's border-b rule
	// and the first content card; without it the audit-log stats strip
	// looks like it's overlapping the rule on narrow viewports (item 12).
	return (
		<div className="@container mt-4 flex flex-col gap-3 sm:gap-4">
			{Array.isArray(children)
				? children.filter(Boolean).map((child, i) => {
						return <div key={`settings-item-${i}`}>{child}</div>;
					})
				: children}
		</div>
	);
}
