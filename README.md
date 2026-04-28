PredEdge is a local-first [Next.js](https://nextjs.org) app for scanning
Polymarket tail-price opportunities and tracking paper trades.

## Local Storage

The app stores scan runs, opportunities, odds snapshots, and paper trades in a
local SQLite database powered by Node's built-in `node:sqlite` module.

- Default database file: `data/prededge.sqlite`
- Override path: `LOCAL_DB_PATH=/absolute/or/relative/file.sqlite npm run dev`
- No Supabase environment variables are required.
- Requires a Node.js runtime with `node:sqlite` support. This workspace was
  tested with Node v25.2.1.

The database is created automatically on first API request.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
