# Security policy

## Supported versions

Migration Doctor is pre-alpha. Security fixes are applied only to the latest tagged pre-release and
the default branch. Older commits and generated report bundles are not maintained release lines.

## Reporting a vulnerability

Use GitHub private vulnerability reporting at the repository's **Security > Advisories > Report a
vulnerability** surface. Do not include secrets, private source code, or exploit payloads in a
public issue.

Include the affected commit, operating system, runtime versions, minimal reproduction, impact, and
whether the issue requires executing an opt-in repository command or Codex adapter. The maintainer
will coordinate disclosure and credit through the private advisory.

## Trust boundaries

Detection is local, read-only, deterministic, and network-free. The scheduled source and evaluation
gates are explicit network surfaces and do not run target repository code. `verify-repository`
executes operator-supplied trusted code with the host user's filesystem and network permissions;
its environment reduction is not a sandbox. See [docs/safety.md](docs/safety.md) for the complete
boundary.
