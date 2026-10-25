# Contributing

Thanks for your interest in ADK. Pull requests are welcome, under the rules below. Anyone can
comment on and review a pull request; only the maintainer
([@lucaseduardocrp](https://github.com/lucaseduardocrp)) approves and merges them.

- **Skills and plugins go to the ADK Hub.** It has its own repository,
  [agent-devkit-hub](https://github.com/lucaseduardocrp/agent-devkit-hub); its README has the
  format and the admission rules.
- **Bug reports and feature ideas** go to GitHub issues. For a bug, include the version, how you
  deployed ADK and the steps to reproduce. For a larger change, open an issue first so we can
  agree on the approach before you write the code.
- **Security issues:** do not open a public issue. See [SECURITY.md](SECURITY.md).

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make your change, with tests. See the [README](README.md#development) for the local setup.
3. Run `npm run verify` in every app you touched (`apps/Backend`, `apps/Frontend`, `apps/Mcp`,
   `apps/Cli`) and `npm run test:coverage` in `setup` if you changed the wizard.
4. Open the pull request against `main` and fill in the template.

### What a pull request needs to be merged

| Requirement                 | Enforced by                                                              |
| --------------------------- | ------------------------------------------------------------------------ |
| Formatting and linters pass | `CI / Verify <app>`: Prettier, ESLint, TypeScript, i18n checks           |
| 100% test coverage          | `CI / Verify <app>`: statements, branches, functions and lines, all apps |
| Integration tests pass      | `CI / Backend integration tests` (PostgreSQL)                            |
| No vulnerable dependencies  | `CI / Dependency review`, CodeQL                                         |
| Review by the maintainer    | Branch ruleset + [CODEOWNERS](.github/CODEOWNERS)                        |
| Conversations resolved      | Branch ruleset                                                           |
| Branch up to date with main | Branch ruleset                                                           |

CI checks the whole repository on every pull request, not only the files it changes: `main`
must stay at 100% coverage in every app. Code that cannot be tested is not merged; refactor it
until it can be.

Pull requests are squash-merged, so the pull request title becomes the commit message on `main`:
write it as a short imperative sentence (for example "Add retries to the E2E runner").

Workflows of first-time contributors run after the maintainer approves them, so CI may take a
while to start on your first pull request.

## License

By submitting a pull request you agree that your contribution is licensed under the project's
[license](LICENSE) (AGPL-3.0-only). The project's name and logo are covered by the
[trademark policy](TRADEMARKS.md).
