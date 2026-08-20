# Contributing to Thearchy

## Development

```bash
npm ci
npm test
npm run validate:plugin
npm run test:stability
npm run test:package
```

## Pull requests

- Keep machine role IDs and template IDs backward compatible.
- Add tests for every state transition, decision type, or permission change.
- Do not add telemetry, remote execution, or secret access.
- Update Chinese and English documentation for user-visible behavior.
- Ensure Windows, macOS, and Linux CI passes.

Official templates remain maintainer-controlled during the Beta period. New
template proposals should begin as an issue containing example tasks and
verification criteria.
