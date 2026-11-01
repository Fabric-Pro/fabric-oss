"use client";

import { cn } from "@ui/lib";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import React from "react";
import { Input } from "./input";

export function PasswordInput({
	value,
	onChange,
	className,
	autoComplete,
}: {
	value: string;
	onChange: (value: string) => void;
	className?: string;
	autoComplete?: string;
}) {
	const [showPassword, setShowPassword] = React.useState(false);

	return (
		<div className={cn("relative", className)}>
			<Input
				type={showPassword ? "text" : "password"}
				className="pr-10"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				autoComplete={autoComplete}
			/>
			<button
				type="button"
				onClick={() => setShowPassword(!showPassword)}
				aria-label={showPassword ? "Hide password" : "Show password"}
				className="absolute inset-y-0 right-0 flex items-center pr-3 text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:text-foreground focus-visible:outline-hidden"
			>
				{showPassword ? (
					<EyeOffIcon className="size-4" />
				) : (
					<EyeIcon className="size-4" />
				)}
			</button>
		</div>
	);
}
