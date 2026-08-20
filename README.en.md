# Thearchy

Thearchy is a local deterministic multi-agent quality governance layer for Codex and Claude Code. It adds explicit planning, independent review, structured execution, verification, and merge approval without providing or requiring another model service.

```bash
npm install
npm test
npm link --workspace packages/cli
thearchy doctor
thearchy install --target all
```

On Windows, double-click `install-codex-desktop.cmd` for a self-contained
Codex desktop installation. The coordinator runtime is embedded in the plugin,
so a global CLI link is not required.

Start a governed run:

```bash
thearchy run start \
  --template feature-delivery \
  --mode auto \
  --task "Implement user authentication"
```

The CLI state machine is authoritative. Host agents must query `thearchy run next`, submit role artifacts, and stop at plan and merge approval gates.

The project is licensed under Apache-2.0 and does not collect telemetry.
