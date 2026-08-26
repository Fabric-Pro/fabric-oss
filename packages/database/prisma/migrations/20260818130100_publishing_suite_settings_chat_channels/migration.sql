-- Publishing Suite 1C-3: the project's selected chat broadcast targets.
--
-- Nullable with no default, so the add is a catalog-only change that takes no
-- table rewrite. NULL and [] both mean "chat is off" — the design has no
-- separate on/off boolean, deliberately, because a second switch is a state in
-- which the product has two answers to "is chat on".
ALTER TABLE "publishing_suite_settings" ADD COLUMN "chatChannels" JSONB;
