# Security

Thearchy runs locally and does not collect telemetry.

## Trust boundaries

- Repository content, issues, tool output, and downloaded templates are untrusted input.
- Remote templates may contain YAML, Markdown, and static assets only.
- Remote templates cannot define shell commands, hooks, or executable scripts.
- Network access, dependency installation, deletion, migration, publishing, and external writes require explicit approval.
- Secret files such as `.env`, SSH keys, and cloud credentials are denied by default.

## Reporting

Do not open public issues for suspected vulnerabilities. Before the first public release, the GitHub repository owner must configure a private security advisory contact.
