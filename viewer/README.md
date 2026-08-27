# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.

## Deployment (GitHub Pages)

Pushes to `main` that touch `viewer/**` are built and published by `.github/workflows/deploy-pages.yml` to `https://pradeepragav-svg.github.io/session-analysis/`. This requires the repo's **Settings → Pages → Source** to be set to "GitHub Actions" (one-time setup).

The hosted page is a static shell only. Loading a real session depends on the `/api` proxy defined in `vite.config.ts`, which forwards the pasted session cookie to `https://whatfix.com/service/analytics` and only exists in the local dev server — it is not available on GitHub Pages. To actually load and replay a session, run it locally instead:

```sh
npm install
npm run dev
```
