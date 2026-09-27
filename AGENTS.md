# AGENTS.md

This guide provides instructions and conventions for agents operating in the uprevit-backend repository.

- Use npm, not Bun or npx.
- Use Git Flow for branching.
- Keep Lambda handlers, API routes, environment variables, and IAM permissions aligned in `template.yaml`.
- Tenant-scoped endpoints must derive workspace and user identity from `requireTenantContext`; do not trust client-supplied scope IDs.
- Changes to Cognito-backed membership or lifecycle state must keep Cognito custom attributes and MongoDB user data in sync.
- Return API responses with `ResponseWrapper` and log unexpected handler errors with `logError`.
- Read `CONTEXT.md` before changing workspace membership, platform operations, or billing behavior.
- Production deployments run through GitHub Actions; do not use `sam deploy --guided`.
- To test the backend locally we have written two commands which are npm run dev and npm run dev:infra. To sync the changes to dev environment in AWS and then we hit that environment endpoint on frontend locally and we use this same envirnment and api endpoint for the develop branch deployed version which is dev-app.uprevit.com and dev.uprevit.com