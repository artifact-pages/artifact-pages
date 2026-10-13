# Contributing

Issues and pull requests are welcome. Open an issue before starting a large change so the approach can be agreed first.

Security vulnerabilities go through the private route in [SECURITY.md](SECURITY.md), not public issues.

## Backlog

Planned work lives in `docs/backlog/`; see the [backlog section of AGENTS.md](AGENTS.md#backlog-and-issue-tracking) for the tracks and rules.

## Local setup

Follow the [Local development](README.md#local-development) section of the README.

## Before opening a pull request

Before opening a pull request, run at least these checks. CI (`.github/workflows/verify.yml`) runs more, including module tidiness, govulncheck, Terraform validation and Action smoke tests.

~~~sh
gofmt -l $(git ls-files '*.go')   # must print nothing
go vet ./...
go test ./... -count=1
npm run build
npm run test:web-unit
npm run test:e2e
~~~

## Pull requests

- Write commits and pull request descriptions in English.
- Pull requests are squash-merged after CI is green.
- Do not edit the generated Action repositories (`artifact-pages/{publish,preview,registry,app-deploy}-action`) or the Terraform package repositories directly. Change `actions/` or `terraform/modules/` in this repository instead.

## License

The project is MIT licensed (see [LICENSE](LICENSE)). Contributions are made under the same license.
