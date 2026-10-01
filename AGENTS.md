# Project instructions

## Git delivery

- After completing and verifying requested code changes, commit the task's changes and push them to `main` unless the user explicitly requests another workflow. Do not stop at local edits.
- Use the user's configured Git author and committer identity. Verify GitHub attribution when needed so eligible commits count on their contribution graph. Do not add a bot co-author or fabricate contribution history.
- Preserve unrelated working files. Never commit secrets, environment files, backups, uploaded originals, or restored cloud data. Do not force-push shared history.
- Report the pushed commit and deployment status separately. Ensure deployment prerequisites are satisfied before new code replaces the running application.

## Design preferences

- Prefer clean, restrained interfaces with discreet secondary actions. Keep controls such as Finish nearly hidden until needed, using small icons and subtle hover or focus feedback instead of prominent filled buttons.
- Design a thoughtful mobile version for every interface change. Make mobile even cleaner and more visually understated than desktop, with compact controls, fewer labels, and less clutter.
- Preserve comfortable touch targets, accessible names, keyboard focus states, and reliable touch access. Subtle mobile controls must remain usable without hover.

## Cloud data preferences

- Treat the deployed cloud version as the primary version. Preserve its existing data and verify changes against the live deployment when authorized.
- Before changing production data or schema, create a current backup and verify it. Prefer a durable private cloud backup, with a local recovery copy when practical. Never replace production data with local development data.
- Keep cloud saves reliable and make failures visible. Maintain automatic backups where supported, and verify backup success instead of assuming a deployment or GitHub push also protects application data.
