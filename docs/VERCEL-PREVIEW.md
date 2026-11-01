# HYMET shareable preview

## Current status

The separate Vercel project `hymet-review` is created, linked to this directory, and configured for Next.js. Its Preview-only safety variables are set below. The project has no deployments yet.

Vercel CLI 65.9.0 rejected an explicit Preview deployment with `first_deployment_production`: a new project's first CLI deployment is assigned to Production. No source was uploaded and no deployment was created. Do **not** retry with `--prod`; that would violate the Preview-only requirement.

## Preview-only deployment path

To avoid a Production deployment, connect `hymet-review` to a private Git repository and push a commit on a branch other than the project's Production branch. Vercel treats non-production branches as Preview and generates a URL for each Preview deployment ([Vercel Git deployments](https://vercel.com/docs/git)). Set the Production branch separately from the review branch before pushing review commits.

This project directory currently has no Git repository or remote. Connecting a private Git provider/repository and publishing the source there is the remaining prerequisite. The Vercel project is already created; do not select the official HYMET Vercel project or attach the production domain.

## Preview environment safety

The new project's **Preview** environment contains only these variables:

```text
NEXT_PUBLIC_ENABLE_MAINNET=false
ENABLE_MAINNET=false
HYPE_DEV_READ_ONLY=true
HYMET_LAUNCH_MODE=native-split
HYMET_DISTRIBUTOR_VERIFIED=false
HYMET_DISTRIBUTOR_APP_VERIFIED=false
HYMET_HOLDER_PAYOUTS_VERIFIED=false
NEXT_PUBLIC_HYMET_HOLDER_REWARDS=false
```

The browser and server transaction gates remain closed, and holder allocations remain disabled. No `DATABASE_URL`, `PINATA_JWT`, keeper/deployer key material, or production credentials were configured. Database-backed listings may be empty/unavailable and metadata upload cannot complete without an isolated preview backend. Public read-only market data uses the existing public fallbacks.

The Vercel CLI dry run detected Next.js and verified `.vercelignore` excludes `.env.local`, `.env.example`, `target`, the supplied source ZIP, and the reference image.

## Sharing

After a Git-based Preview deployment is ready, copy its generated `https://…vercel.app` URL from the deployment details. Preview access may require Vercel authentication depending on Deployment Protection settings; do not change the official production project's access settings to share this preview. Never deploy this project with `--prod`.
