# Security

Mesho is an early-stage tool. Run it in an environment you administer and back up data before upgrades.

## Trust boundaries

- Remote users supply messages and proposed goals, not local execution configuration.
- Recipients control the CLI, directory, trust settings and execution limits.
- CLI permissions govern agent capabilities. Mesho is not an OS sandbox and cannot guarantee immunity to prompt injection.
- Messages and shared output are stored on the team server. There is no end-to-end encryption. Use TLS for network deployments.
- Model providers retain their own authentication, billing and data policies.
- Windows builds are currently unsigned. Review source and use a trusted build.

## Reporting

Use GitHub private vulnerability reporting if enabled. Otherwise open an issue requesting a private channel without exploit details, credentials or private data. Provide the affected version, impact and minimal reproduction privately once a channel is established. There is no guaranteed response SLA.
