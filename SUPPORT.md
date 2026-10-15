# Support (PostHog Support) setup

Customers send feedback from **Send feedback** in the app sidebar and the docs sidebar. Messages become tickets in PostHog Support, which is the source of truth for tickets and replies. Customers can read replies and follow up in the same thread under **Your conversations**. Resolved threads stay readable; further help starts a new message. They never get a PostHog login.

How it fits together:

- **Identity.** `GET /support/config` uses `requireTenantContext`. It returns the caller's Uprevit user ID as the Support `distinctId`, plus an HMAC-SHA256 hex digest of that ID, signed with the PostHog Support secret. The secret never leaves the backend.
- **Screenshots.** Customers can add up to 4 PNG, JPEG, GIF or WebP images, 5 MB each. Nothing is captured automatically. Images go to a private S3 bucket through a short-lived S3 POST policy. The ticket contains stable links in the form `https://<app>/support/attachments/<id>`, never S3 URLs.
- **Screenshot reviewers.** `GET /support/attachments/{id}` does not use workspace membership. It verifies the Cognito access token for the environment, loads the user with `AdminGetUser`, and requires an enabled user with `email_verified=true` whose email is on the reviewer allowlist in SSM. The UI page `/support/attachments/<id>` is outside the workspace app shell, so it works for Cognito-only accounts.
- **Session replay.** Replay is off unless a workspace admin turns on **Settings → Workspace → Support → Session replay for support**. The SDK starts with replay disabled. It only starts strict, masked recording on signed-in app and docs pages after a fresh, signed `/support/config` response confirms the current workspace opted in. Recording stops while config is loading or refetching, on config errors or missing signatures, on sign-out, on account or workspace change, and on the screenshot viewer. The config refreshes on focus and every five minutes while the app is active. Changes made elsewhere propagate on the next refresh; they are not immediate in every open tab.
- **Transport privacy.** Support message and restore requests use the SDK's public `rewriteRequestPath` hook to reach the frontend proxy. It redacts page path IDs and removes query strings and fragments before forwarding to the exact configured US/EU ingestion origin. The proxy validates the browser's Origin against `NEXT_PUBLIC_APP_URL` (or the request origin when unset) and forwards that app origin for PostHog's allowed-domain checks, without forwarding cookies, authorization or referrer headers. Signed identity and session replay links are preserved.
- **Account transitions.** The first signed identity preserves the SDK's loaded Support configuration. Sign-out clears identity and resets the SDK. A rare account switch inside the same page triggers a full reload after reset so Support configuration is loaded again through normal SDK initialization.

## 1. PostHog project

1. Use one PostHog project per environment (dev, demo, prod), or one shared project if you accept mixed data. Note the region:
   - US Cloud ingestion host: `https://us.i.posthog.com`
   - EU Cloud ingestion host: `https://eu.i.posthog.com`
2. Copy the **Project token** (public, starts with `phc_`) from **Project settings → General**.
3. Set these Amplify environment variables for each frontend app (and `apps/app/.env.local` for local work):
   - `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` = project token
   - `NEXT_PUBLIC_POSTHOG_HOST` = ingestion host for your region, exactly as above with no trailing slash (the Support proxy rejects any other host)
   If the token is missing, the dialog shows that Support is unavailable and nothing is sent to PostHog.

## 2. Support settings

In **Support → Settings**:

1. Enable Support for the project.
2. **In-app widget:** leave **Enable widget** off. The app uses its own dialog through the JavaScript API, so no floating launcher should appear. Do not set `disable_conversations` in code; that turns off the API as well.
3. **Allowed domains:** use `dev-app.uprevit.com` and `localhost` on dev, `demo-app.uprevit.com` on demo, and `app.uprevit.com` on prod.
4. **Secret API key:** generate it if empty and copy it. Store it only in SSM (step 4). This is the Support secret, not a project or personal API key.
5. **Notifications (optional):** set up email or Slack notifications for new tickets so the team sees them.

## 3. Session replay settings

In **Project settings → Session replay**:

1. Turn on **Record user sessions**. The SDK only starts recording for workspaces that opted in, so this does not record everyone. Turning it off in the project would also stop replay for opted-in workspaces.
2. Keep **Capture console logs**, **Capture network requests** and **Canvas capture** off. The SDK also disables them locally.
3. Under **Privacy and masking**, choose the strictest masking. The SDK enforces its own masking either way: all inputs and all text are masked, and images, video, audio, canvas, SVG, iframes and embedded objects are blocked. URLs keep only the route, with IDs replaced by `:id` and no query or hash.
4. Add the app domains under **Authorized domains** if the project restricts them.

Autocapture, pageviews, heatmaps, dead clicks, rage clicks, web vitals, exceptions, surveys and product tours are disabled in the SDK. The app only sends Support events, `$identify`, and replay snapshots.

## 4. SSM parameters

Create two SecureString parameters per environment, in `us-east-1`. Use `dev`, `demo` and `prod` for `<environment>`:

| Parameter | Value |
| --- | --- |
| `/uprevit/<environment>/support/identity-secret` | Secret API key from **Support → Settings** |
| `/uprevit/<environment>/support/reviewer-emails` | Comma-separated emails of the people allowed to view screenshots |

Exact paths:

- `/uprevit/dev/support/identity-secret`, `/uprevit/dev/support/reviewer-emails`
- `/uprevit/demo/support/identity-secret`, `/uprevit/demo/support/reviewer-emails`
- `/uprevit/prod/support/identity-secret`, `/uprevit/prod/support/reviewer-emails`

To avoid putting values in shell history, read them from a prompt:

```bash
read -rs VALUE && aws ssm put-parameter --region us-east-1 --type SecureString --overwrite \
  --name /uprevit/dev/support/identity-secret --value "$VALUE"; unset VALUE
```

Notes:

- Reviewer emails are compared case-insensitively with the **verified Cognito email** of the signed-in user. Each reviewer needs a Cognito account in that environment's user pool. They do not need to belong to any workspace, and this access does not grant any workspace access.
- If the reviewer parameter is missing or empty, nobody can view screenshots.
- If the identity secret is missing, sending is disabled and the dialog says Support is not set up.
- The backend caches both values for up to 5 minutes, so changes and removals apply within that time.
- Never put these values in GitHub variables, `NEXT_PUBLIC_*` variables, MongoDB, or logs.

## 5. Deploy configuration

Add these **GitHub environment variables** (not secrets) to the `develop`, `demo` and `prod` environments of the backend repo:

| Variable | Example (dev) |
| --- | --- |
| `POSTHOG_SUPPORT_SECRET_PARAM` | `/uprevit/dev/support/identity-secret` |
| `SUPPORT_REVIEWER_EMAILS_PARAM` | `/uprevit/dev/support/reviewer-emails` |
| `SUPPORT_ATTACHMENTS_ALLOWED_ORIGINS` | `https://dev-app.uprevit.com,http://localhost:8080` |

`SUPPORT_ATTACHMENTS_ALLOWED_ORIGINS` sets the S3 CORS origins for screenshot uploads. Separate origins with commas and no spaces. Add `http://localhost:8080` only on dev. If it is empty, browsers cannot upload screenshots.

Use `https://demo-app.uprevit.com` for the demo stack (`uprevit-stage`) and `https://app.uprevit.com` for prod (`uprevit-prod`).

For the dev stack (`npm run dev:infra` / `sam sync`), pass the same values once as parameter overrides. Later syncs keep them:

```bash
AWS_PROFILE=uprevit-amit sam sync --stack-name uprevit-test --region us-east-1 --no-build-in-source \
  --parameter-overrides \
  PosthogSupportSecretParam=/uprevit/dev/support/identity-secret \
  SupportReviewerEmailsParam=/uprevit/dev/support/reviewer-emails \
  SupportAttachmentsAllowedOrigins=https://dev-app.uprevit.com,http://localhost:8080
```

For local SAM, copy the support function sections from `env.example.json` into `env.json`.

## 6. Screenshot storage

The stack creates one bucket per stack: `<stack-name>-support-attachments-<account-id>`. The bucket:

- blocks all public access and enforces bucket-owner object ownership
- uses SSE-S3 (AES256) default encryption
- denies requests that do not use TLS
- has versioning enabled. Reviewers are always served the exact version verified at upload, so re-using an upload policy cannot replace a confirmed image.
- allows CORS `POST` only from the configured origins
- is retained when the stack is deleted or the bucket is replaced

Uploads use an S3 POST policy that expires after 5 minutes and is bound to the exact key, content type and byte size. After upload, the backend checks the object's size, content type and image signature before the screenshot can be linked. Reviewers get a view URL that expires after 60 seconds.

MongoDB stores metadata only, in the `supportAttachments` collection: attachment ID, S3 key, uploader user, workspace and Cognito sub, expected content type and size, ready flag, verified version, and timestamps.

**Retention is not configured yet.** No lifecycle rules delete screenshots or old versions. Once you decide on a retention period, add a lifecycle rule to the bucket that expires current versions after that period, expires noncurrent versions, and aborts incomplete uploads. Also decide whether to remove old `supportAttachments` records at the same time.

## 7. Team access in PostHog

Only the Uprevit team reviews tickets:

1. Invite the 3–4 founders and developers to the PostHog organization (**Organization settings → Members → Invite**). Customers are never invited.
2. Give them access to the Support projects. If your plan has project access control, restrict each project to these members.
3. Use their Uprevit Cognito accounts (with verified emails) in each environment for the screenshot allowlist in step 4.

## 8. GitHub channel (optional, later)

PostHog's GitHub channel creates Support tickets from **new GitHub issues in monitored repos**, and syncs comments and replies both ways for those tickets. It does **not** create GitHub issues from tickets that customers send from the app.

If you want a customer ticket tracked in GitHub, create the issue yourself and link the ticket in it, or build a separate automation later. To connect the channel: install the PostHog GitHub App from the GitHub integration page, then pick repositories in **Support → Settings → GitHub**.
