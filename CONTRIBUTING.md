# Contributing

Read [AGENTS.md](AGENTS.md) before changing the package. Pull requests must
pass the complete gate on Node.js 22 and 24:

```sh
npm ci
npm run format:check
npm run check
npm test
```

The tests start Azurite and run the same contract over the memory and Azure
Tables stores.
