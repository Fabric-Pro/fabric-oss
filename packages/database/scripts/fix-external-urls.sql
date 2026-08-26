-- Fix external URLs that have relative paths
-- This script constructs full URLs from relative paths using the PM tool base URL

-- First, let's see what we're dealing with
-- SELECT id, identifier, "externalUrl" FROM user_story WHERE "externalUrl" IS NOT NULL AND "externalUrl" LIKE '/%';

-- Fix Fizzy URLs (app.fizzy.do)
-- Pattern: /000000/cards/183.json -> https://app.fizzy.do/000000/cards/183
UPDATE user_story
SET "externalUrl" = 'https://app.fizzy.do' || REPLACE("externalUrl", '.json', '')
WHERE "externalUrl" IS NOT NULL
  AND "externalUrl" LIKE '/%'
  AND "externalUrl" NOT LIKE 'http%';

-- Verify the fix
-- SELECT id, identifier, "externalUrl" FROM user_story WHERE "externalUrl" IS NOT NULL LIMIT 20;
