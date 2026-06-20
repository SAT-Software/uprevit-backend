# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-06-19

### Added

- Added workspace tenancy enforcement across critical list, create, and resource-by-id API handlers.
- Added platform operator APIs and SAM routes for workspace administration.
- Added billing domain model with workspace and platform-admin billing HTTP APIs.
- Added Chargebee integration with usage sync, webhooks, invoice detail, and PDF download APIs.
- Added soft user removal, member reactivation, and workspace access freeze enforcement.
- Added CloudFront signed URL delivery for documentation videos with S3 fallback.
- Added billing backfill scripts and npm targets for usage data migration.

### Updated

- Updated usage enforcement to meter uploads, seats, and queued exports with live usage limits.
- Updated CloudFront signing key loading from SSM Parameter Store at runtime.
- Updated package versions to `0.5.0`.

### Fixed

- Fixed Chargebee webhook retry behavior, subscription mirroring, and past due sync.
- Fixed Cognito rollback on failed user reactivation and seat overage scenarios.
- Fixed SAM deploy CI parameter override handling for empty CloudFormation values.
- Fixed tenant validation for invalid workspace IDs and scoped S3 GET key checks.

## [0.4.0] - 2026-05-28

### Added

- Added signed URL API and S3 seed assets for documentation walkthrough videos.
- Added unit test coverage for list queries, exports, and product helpers.

### Updated

- Updated root `npm run dev` workflow for live SAM cloud sync with improved package scripts and dependencies.
- Updated package versions to `0.4.0`.

### Fixed

- Fixed documentation video key allowlist validation using `Object.hasOwn` for compatibility.
- Fixed documentation video key type check compatibility.
- Fixed SAM infrastructure dev scripts from PR review feedback.

## [0.3.0] - 2026-05-23

### Added

- Added shared list query parsing and a MongoDB filter builder for paginated workspace APIs.
- Added list query support to departments, projects, and products handlers.
- Added pagination, sorting, and filtering to the workspace users endpoint.

### Updated

- Updated department retrieval to run related lookups concurrently with `Promise.all`.
- Updated TypeScript build config to ignore TypeScript 6 deprecations during compilation.
- Updated package versions to `0.3.0`.

### Fixed

- Fixed legacy audit action determination logic for product data changes.
- Fixed project list sorting to support workspace table header sort fields.
- Fixed archive list sorting for departments and products, including `users` and `actionBy` mappings.
- Fixed workspace list status filtering so `statusValues` stays aligned with `filter.status`.

## [0.2.0] - 2026-05-04

### Added
- Standard symbols library API with authenticated `/standard-symbols` access and signed image URLs.
- Standard symbols data model, seed script, manifest, and image contact sheet for populating the standard symbol library.
- Product Symbols & Graphics support for adding standard symbols with duplicate detection, standard reference tracking, and default `text_present` handling.
- Product Information fields for Class of Device and Basic UDI-DI, including product defaults, update support, reports exports, and product PDF/Excel exports.
- Workspace-, product-, source-file-, and pending-owner-scoped S3 upload key paths for better asset organization and ownership.
- Root `npm run dev` workflow for live SAM cloud sync with `sam sync --watch --build-in-source`.
- Demo branch deployment support in GitHub Actions using the `demo` GitHub environment variables.

### Updated
- Product data update auditing to include the new Product Information fields and standard symbol additions.
- Product data reads to sign standard symbol images from the standard symbols bucket while continuing to sign uploaded product assets from the uploads bucket.
- Workspace admin onboarding to normalize admin emails, derive a better admin name fallback, and move pending workspace logo uploads into the created workspace path.
- Workspace model and onboarding flow so `companyId` is optional instead of required.
- SAM template and environment examples to include the standard symbols bucket and related Lambda permissions.
- Local SAM build guidance and scripts to use `--build-in-source` where needed.

### Fixed
- Standard symbol signing and duplicate handling when adding library symbols to products.
- Standard symbol add flow so missing `text_present` values default safely.
- Product custom field updates so existing field IDs and `parent_id` values are preserved instead of creating replacement fields.
- Label component validation and updates so descriptions can remain optional on partial updates.
- Label tag updates so descriptions are only changed when provided.
- Product status authorization so completed products can be submitted by non-admin users while admin-only status changes remain protected.
- Symbols & Graphics updates so replacing a standard symbol image clears standard-symbol metadata.

### Removed
- SAM Application Insights resources from the backend template.
- Automatic deletion of replaced product asset S3 objects during product data updates.
- Obsolete local product export testing notes.

## [0.1.0] - 2026-04-03

### Added
- Initial production release of the Uprevit backend.
- AWS SAM deployment workflow via GitHub Actions for develop, stage, and prod environments.
- Cognito-based token validation for protected API endpoints.
- MongoDB-backed APIs for core onboarding, workspace, department, project, product, source file, bookmark, report, and export flows.
- S3-backed file storage and export download support.
- SQS-backed export job processing.
