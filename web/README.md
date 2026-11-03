# web

The TanStack Start app that serves the editor and holds the Modal credential.

Read the [root README](../README.md) first — it covers the architecture, the two
models, and the cost model. This file is only the web-specific commands.

```sh
pnpm install
cp .env.example .env      # IMAGE_EDITOR_API_URL, MODAL_PROXY_TOKEN_ID, MODAL_PROXY_TOKEN_SECRET
pnpm dev                  # http://localhost:3000
```

| Command | What |
|---|---|
| `pnpm dev` | Vite dev server on port 3000 |
| `pnpm build` | production build (Nitro output, what Vercel runs) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | eslint |
| `pnpm format` | prettier + eslint --fix |
| `pnpm generate-routes` | regenerate `src/routeTree.gen.ts` after adding a route |

## Where things are

| Path | What |
|---|---|
| `src/routes/index.tsx` | the whole studio: stage, composer, wait, result |
| `src/routes/__root.tsx` | HTML shell, theme script, error + 404 |
| `src/lib/edit.ts` | the only module that talks to Modal (server-only) |
| `src/lib/credit.ts` | credit server function |
| `src/lib/credit-store.ts` | credit cache + subscription |
| `src/styles.css` | design tokens (light/dark) and all component CSS |

## Two rules that are easy to break

1. **No `VITE_` prefix on any credential.** TanStack Start inlines `VITE_`-prefixed
   values into the browser bundle; the token would be public.
2. **Only `src/lib/*.ts` may read `process.env`.** Everything else is client code.

## Deploy

```sh
pnpm dlx vercel deploy --prod
```

`vercel.json` declares `framework: tanstack-start`. Set the three environment
variables in Vercel → Settings → Environment Variables, then redeploy.
