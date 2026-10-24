# dsh-ssh — agent rules

## Comments

- Do NOT add comments. No JSDoc, no `@param`/`@returns`, no section banners,
  no "why this design" blocks, no narrating what the code plainly does.
- The codebase is deliberately comment-sparse; keep it that way. When editing,
  do not reintroduce removed comments.
- The only exception: a pre-existing one-line comment marking a fact that
  prevents a real bug (e.g. `#private` fields are forbidden on cordis
  services, `control:` must always be present as a key, mutations are never
  replayed). Keep those; do not expand them into paragraphs and do not create
  new ones without a bug-prevention justification.

## Other invariants

- `AGENT_SCRIPT` in `src/agent-script.ts` is string content pinned by a
  SHA-256 test — never edit the string array.
- Behavior changes must keep `npm test` (17/17) and `npm run build` green.
