# Deployment

## Vercel
Use the Next.js application under `backend` as the deployment root. Configure `DATABASE_URL`, `JWT_SECRET`, `CRON_SECRET`, `APP_BASE_URL`, and real provider/storage secrets in Vercel environment variables. Set `APP_MODE=GOVERNMENT_DEMO` only for the isolated government demo so every page visibly states that no government or financial integration is live. Run Prisma generate during install/build as required by the deployment environment.

The Vercel Hobby-compatible demo uses one daily `/api/cron/maintenance` job that runs the four maintenance tasks. A production launch that requires five-minute expiry processing must move to a plan that supports the shorter interval before changing the schedule.

Never require a `public` output directory for Next.js. Do not deploy `.env` files.

## Round 2 deployment gate

The project officially uses npm (`npm@10.9.2`) and Node 22.x. CI/Vercel must use `npm ci` with the committed `package-lock.json`. Do not mark build readiness until `prisma validate`, `prisma generate`, migration deploy/status, typecheck, lint, tests, a `NODE_ENV=production` build, and `npm start` plus `/api/health` have all executed successfully.
