"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner } from "sonner";
import { MAX_PERSISTENT_ERROR_TOASTS } from "./toast-error-cap";
import { installPersistentErrorToastDefaults } from "./toast-error-defaults";

// Global UX policy: error toasts persist until the user dismisses them (never
// auto-close). Installed once at module scope — before the Toaster (and thus
// any toast) can render. See toast-error-defaults.ts for the rationale.
installPersistentErrorToastDefaults();

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
	const { theme = "system" } = useTheme();

	return (
		<Sonner
			theme={theme as ToasterProps["theme"]}
			className="toaster group"
			// REQ-7/REQ-8: persistent error toasts stack in a collapsed,
			// depth-cued treatment; up to the cap render in that stack.
			// `expand={false}` is sonner's default — the stack is COLLAPSED by
			// default and still fans out on hover/focus (sonner toggles its own
			// `expanded` state on mouseenter; the `expand` prop only FORCES the
			// stack permanently open, it does not gate hover expansion).
			// The store-level replace-oldest cap lives in toast-error-defaults.ts;
			// `visibleToasts` here lets all retained errors be visible (sonner's
			// default is only 3) and must equal the cap — toast.visibility.test.tsx
			// pins that. It is global (not per-type), so success/info toasts (which
			// still auto-dismiss at 5s) may now show up to 10 at once rather than
			// 3: a benign density change; their timing is unchanged.
			visibleToasts={MAX_PERSISTENT_ERROR_TOASTS}
			expand={false}
			toastOptions={{
				classNames: {
					toast: "group toast !rounded-lg !font-sans group-[.toaster]:bg-card group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-md",
					description: "group-[.toast]:text-muted-foreground",
					actionButton:
						"group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
					cancelButton:
						"group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
					success: "!text-success",
					error: "!text-destructive",
				},
				duration: 5000,
			}}
			{...props}
		/>
	);
};

export { Toaster };
