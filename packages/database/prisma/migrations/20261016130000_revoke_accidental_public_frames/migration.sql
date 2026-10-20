-- Frames made outside a project or a surface used to be created public with a
-- share token, while their scope said PRIVATE: anyone with the link could open
-- a page its owner was shown as private. Nobody chose these links (a deliberate
-- public share sets the scope to PUBLIC), so they are revoked; an owner who
-- wants one back shares the page publicly again.
UPDATE "agent_workspace_file"
   SET "isPublic"   = false,
       "shareToken" = NULL
 WHERE "fileType" = 'FRAME'
   AND "isPublic" = true
   AND "shareScope" = 'PRIVATE';
