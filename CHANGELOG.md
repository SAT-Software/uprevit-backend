# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-03

### Added
- Initial production release of the Uprevit backend.
- AWS SAM deployment workflow via GitHub Actions for develop, stage, and prod environments.
- Cognito-based token validation for protected API endpoints.
- MongoDB-backed APIs for core onboarding, workspace, department, project, product, source file, bookmark, report, and export flows.
- S3-backed file storage and export download support.
- SQS-backed export job processing.
