# uprevit-backend

Serverless backend for Uprevit, built with AWS SAM, AWS Lambda, API Gateway, MongoDB, Cognito, S3, and SQS.

The main infrastructure entrypoint is `template.yaml`, and the application code lives under `src/`.

## Current Release

**0.8.0** supports the Uprevit Beta app with approval workflows, product ownership, lifecycle tracking, and in-app and email notifications. Submitting a product marks it Submitted; completing an approval workflow releases its included versions together and makes earlier releases Obsolete.

The release also includes workflow image attachments, advanced search, product-team permissions, and product export improvements. See [CHANGELOG.md](./CHANGELOG.md) for the full release notes. Use it with the matching `0.8.0` UI release.

## Environment Variables

For local SAM development, put runtime environment variable names in `env.json` and pass that file with `--env-vars`.

Start from `env.example.json`, then create your local ignored `env.json` with real values.

The required runtime keys are:

- `MONGODB_URI`: The MongoDB connection string
- `DB_NAME`: The MongoDB database name
- `USER_POOL_ID`: The Cognito User Pool ID
- `CLIENT_ID`: The Cognito App Client ID
- `UPLOADS_BUCKET`: The S3 bucket used for uploaded files
- `EXPORTS_BUCKET`: The S3 bucket used for generated exports
- `DOCUMENTATION_FILES_BUCKET`: The S3 bucket for documentation media (`uprevit-documentation-files`)
- `DOCS_VIDEO_URL_EXPIRES_IN_SECONDS`: Signed URL lifetime in seconds (default `86400` when using CloudFront)

Documentation video CloudFront signing (on `GetDocumentationVideoSignedUrlFunction` only, or in GitHub for deploy):

- `DOCUMENTATION_CLOUDFRONT_DOMAIN`: e.g. `d123.cloudfront.net`
- `DOCUMENTATION_CLOUDFRONT_KEY_PAIR_ID`: from CloudFront key management
- `DOCUMENTATION_CLOUDFRONT_PRIVATE_KEY`: PEM private key (`env.json` locally — do not commit; deployed Lambdas load the PEM from SSM at runtime using `DOCUMENTATION_CLOUDFRONT_PRIVATE_KEY_PARAM`)
- `EXPORT_JOB_QUEUE_URL`: The SQS queue URL used by export jobs

AWS SAM `--env-vars` expects Lambda environment variable names, not CloudFormation parameter names like `MongoDbUri` or `UserPoolId`.
The local helper script normalizes your ignored `env.json` into `.sam-local-env.json` before startup.

## Production Deployment

Production deployment is handled by GitHub Actions, not by running `sam deploy --guided` manually.

Branch to environment mapping:

- `develop` -> GitHub environment `develop`
- `demo` -> GitHub environment `demo`
- `main` -> GitHub environment `prod`

Release branches (for example `release/x.y.z`) do not trigger deployment. Deployments happen when the release is merged to `main` (prod) or back to `develop` (develop).

The deploy workflow reads non-secret configuration from GitHub environment variables. It loads `MONGODB_URI` from AWS Systems Manager Parameter Store using `MONGODB_URI_PARAM`, and passes `DOCUMENTATION_CLOUDFRONT_PRIVATE_KEY_PARAM` (the SSM path for the CloudFront signing PEM) so the documentation video Lambda can load the key at runtime.

After a successful deploy, the backend API base URL comes from the CloudFormation stack output `ApiBaseUrl`. That is the base URL the frontend should use for production.

## Local Development

To run the application locally:

1. Install dependencies:
   ```bash
   cd src
   npm install
   ```

2. For live code sync during development, use the root dev script:
   ```bash
   npm run dev
   ```

   This script uses `sam sync --code --watch --build-in-source` for Lambda code changes.

   For template changes such as new routes or environment variables, run a one-shot infrastructure sync:
   ```bash
   npm run dev:infra
   ```

   Infrastructure sync builds outside `src/`, and SAM builds are configured to run nonparallel because all functions share that source directory. The script restores local dev dependencies when sync exits, including after a failed sync. Use `npm run dev:infra:watch` only when you intentionally need to watch template changes.

   Make sure your local AWS SAM CLI version is `>= 1.104.0` before running these commands.

3. Build and run with SAM:
   ```bash
    cp env.example.json env.json
    npm run start:local
    ```

   If you are using built artifacts:

   ```bash
   cd src
   npm run start:local:build
   ```

## Release Flow

Recommended release flow:

1. Cut `release/x.y.z` from the latest `develop` and finalize release changes (pushes to the release branch do not deploy)
2. Merge the release branch into `main`
3. Let GitHub Actions deploy `main` to the `prod` environment
4. Verify the deployed API and stack outputs
5. Create the release tag
6. Merge `main` back into `develop`

Keep release versions aligned with `../uprevit-ui`, and merge and verify the backend before the UI. For this release, use `release/0.8.0` and create the `v0.8.0` tag after production verification.

Existing databases need the product lifecycle migration (`src/scripts/migrateProductLifecycle.ts`) and Product Owner backfill (`src/scripts/backfillProductOwners.ts`). Rehearse both on dev with `--dry-run` first and verify their counts. The lifecycle migration maps legacy Submitted versions to Released or Obsolete and separates archiving from status; the owner backfill preserves existing owners and fills missing ones from the creator or an active workspace admin.

### 0.8.0 data migrations

`migrate:workflow-release` runs the lifecycle migration and then the owner backfill on one deployed environment. It reads the MongoDB URI from that environment's SSM parameter, never prints it, and plans only unless `--apply` repeats the database name. It stops if `MONGODB_URI` is set, if `DB_NAME` names another database, or if the SSM URI names another database. When the target database has no products, it checks with the AWS CLI that the deployed stack's Lambda uses the same URI and database and that the cluster has no database differing only by case, then reports zero updates; otherwise it stops. Both steps only change versions that still need them, so a second run reports zero lifecycle updates and only the owner backfills still pending, such as products it could not resolve.

| Target | Branch | Stack | Database | SSM parameter |
|---|---|---|---|---|
| `prod` | `main` | `uprevit-prod` | `Uprevit-prod` | `/uprevit/prod/backend/MONGODB_URI` |
| `demo` | `demo` | `uprevit-stage` | `uprevit-stage` | `/uprevit/stage/backend/MONGODB_URI` |

For each environment, in this order:

1. Let GitHub Actions deploy the `0.8.0` backend to the environment.
2. Plan: `AWS_PROFILE=uprevit-amit npm --prefix src run migrate:workflow-release -- --target prod`
3. Apply straight away, before people edit products: `AWS_PROFILE=uprevit-amit npm --prefix src run migrate:workflow-release -- --target prod --apply Uprevit-prod`
4. Plan again and confirm the lifecycle step reports zero updates and any owner backfills still pending are expected, then release the UI.

For demo, use `--target demo` and `--apply uprevit-stage`. A plan does not write the lifecycle changes, so its owner backfill reads versions before they get a lineage and its owner counts are provisional; `--apply` runs the backfill after the lifecycle migration. Dev already ran the individual scripts (`migrate:product-lifecycle`, `backfill:product-owners`), which still work with `MONGODB_URI` and `DB_NAME`.

## Recent Fixes

- Fixed MongoDB connection issue by removing dotenv dependency and using environment variables directly in Lambda
- Updated SAM template to include required environment variables
- Improved error handling and logging in the Lambda function
- Added local SAM env normalization so ignored `env.json` files are converted to the AWS-documented `--env-vars` format before startup

## Local Build And Test

Build the application with the `sam build` command.

```bash
uprevit-backend$ sam build
```

The SAM CLI installs dependencies defined in `src/package.json`, compiles TypeScript with esbuild, creates a deployment package, and saves it in the `.aws-sam/build` folder.

Test a single function by invoking it directly with a test event. An event is a JSON document that represents the input that the function receives from the event source. Test events are included in the `events` folder in this project.

Run functions locally and invoke them with the `sam local invoke` command.

```bash
uprevit-backend$ sam local invoke HelloWorldFunction --event events/event.json
```

The SAM CLI can also emulate the application's API. Use `sam local start-api` to run the API locally on port 3000.

```bash
uprevit-backend$ sam local start-api
uprevit-backend$ curl http://localhost:3000/
```

The SAM CLI reads the application template to determine the API's routes and the functions that they invoke. The `Events` property on each function's definition includes the route and method for each path.

```yaml
      Events:
        HelloWorld:
          Type: Api
          Properties:
            Path: /hello
            Method: get
```

## Infrastructure

The application template uses AWS Serverless Application Model (AWS SAM) to define Lambda functions, API Gateway routes, queues, buckets, and related IAM permissions. For resources not covered by the SAM specification, standard CloudFormation resource types can be used in the same template.

## Fetch, tail, and filter Lambda function logs

To simplify troubleshooting, SAM CLI has a command called `sam logs`. `sam logs` lets you fetch logs generated by your deployed Lambda function from the command line. In addition to printing the logs on the terminal, this command has several nifty features to help you quickly find the bug.

`NOTE`: This command works for all AWS Lambda functions; not just the ones you deploy using SAM.

```bash
uprevit-backend$ sam logs -n HelloWorldFunction --stack-name uprevit-backend --tail
```

You can find more information and examples about filtering Lambda function logs in the [SAM CLI Documentation](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-logging.html).

## Documentation videos (S3 seed)

Place `.mp4` files under `src/scripts/documentation-videos-input/` (folder layout matches the product team's export).

From the repo root (or `src/`):

```bash
cd src && npm install   # installs @aws-sdk/client-s3 (required by the seed script)
npm run seed:documentation-videos -- --scan-dir
npm run seed:documentation-videos -- --dry-run
npm run seed:documentation-videos
```

From the repo root: `npm run seed:documentation-videos -- --dry-run` (forwards flags to `src/`).

Requires `AWS_REGION` and credentials with `s3:PutObject` on `DOCUMENTATION_FILES_BUCKET` (default `uprevit-documentation-files`).

### CloudFront signed video URLs

`GET /docs/videos/{videoKey}/signed-url` returns a **CloudFront signed URL** when domain, key pair id, and private key PEM are set.

**GitHub (per environment):** variables `DOCUMENTATION_CLOUDFRONT_DOMAIN`, `DOCUMENTATION_CLOUDFRONT_KEY_PAIR_ID`, and `DOCUMENTATION_CLOUDFRONT_PRIVATE_KEY_PARAM` (SSM Parameter Store path only — not the PEM itself). Store the full private PEM in AWS Systems Manager as a **SecureString** at that path (multiline PEM is fine). The key pair id must be the CloudFront public key ID for the public key generated from that exact private key.

**Local:** copy `GetDocumentationVideoSignedUrlFunction` from `env.example.json` into `env.json` with the same three values.

If those are empty, the API falls back to **S3 presigned GET**.

After deploy, confirm the `.mp4` host is `*.cloudfront.net` in the browser Network tab.

## Unit Tests

Backend tests use Jest from `src/`.

```bash
cd src
npm install
npm run test
```

## Cleanup

To delete a deployed stack, use the AWS CLI. Assuming you used your project name for the stack name, you can run the following:

```bash
sam delete --stack-name uprevit-backend
```
