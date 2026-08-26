import React from "react";
import { Input, type InputProps } from "./input";

/**
 * A text search field that does not trip browser credential/email autofill.
 *
 * Drop-in replacement for `<Input>` on search boxes: defaults to
 * `type="search"` and `autoComplete="off"` so browsers treat it as a plain
 * search field instead of a login/email input (which otherwise pops the saved
 * account autofill dropdown). Both defaults are overridable via props, and
 * every other `InputProps` (value, onChange, placeholder, className, …)
 * forwards through unchanged — so migrating a search box is a rename plus an
 * import swap, nothing else.
 */
const SearchInput = React.forwardRef<HTMLInputElement, InputProps>(
	({ type = "search", autoComplete = "off", ...props }, ref) => {
		return (
			<Input
				ref={ref}
				type={type}
				autoComplete={autoComplete}
				{...props}
			/>
		);
	},
);

SearchInput.displayName = "SearchInput";

export { SearchInput };
