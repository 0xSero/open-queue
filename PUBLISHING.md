# Publishing Guide (npm + opencode.cafe)

This guide assumes you already have an npm account and are logged in locally.

## 1) Prep

- Update `package.json` version (semver).
- Run `bun run build`.
- Verify the build output in `dist/`.

## 2) Publish to npm

```bash
npm login
npm publish --access public
```

## 3) Verify install

```bash
bun add opencode-message-queue
```

## 4) Submit to opencode.cafe

- Open https://www.opencode.cafe/
- Find the plugin submission form/listing instructions.
- Provide:
  - npm package name: `opencode-message-queue`
  - GitHub repo URL (if you have one)
  - Short description and README
  - Screenshot or asset (optional): `assets/queue-power.svg`

## 5) Update README badges (optional)

If you want a version badge, add one after first publish.

```md
[![npm version](https://img.shields.io/npm/v/opencode-message-queue.svg)](https://www.npmjs.com/package/opencode-message-queue)
```
