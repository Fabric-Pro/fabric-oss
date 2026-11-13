-- Fizzy #1444: a person's high-contrast theme choice, kept on the account so it
-- follows them to every browser and device they sign in from.
--
-- Nullable with no default: NULL is "never chose", which renders the standard
-- palette, so existing rows need no backfill and the column costs nothing until
-- someone turns the theme on. Text rather than an enum on purpose — see the
-- comment on User.contrastPreference.
ALTER TABLE "user" ADD COLUMN "contrastPreference" TEXT;
