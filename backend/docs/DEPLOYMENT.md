# Deployment

## Vercel
Use the Next.js application under `backend` as the deployment root. Configure `DATABASE_URL`, `JWT_SECRET`, and real provider/storage secrets in Vercel environment variables. Run Prisma generate during install/build as required by the deployment environment.

Never require a `public` output directory for Next.js. Do not deploy `.env` files.

## Round 2 deployment gate

The project officially uses npm (`npm@10.9.2`) and Node >=20. CI/Vercel must use `npm ci` once a committed `package-lock.json` is generated in a networked environment. Do not mark build readiness until `prisma generate`, migrations, typecheck, tests, production build and `npm start` have all executed successfully.
