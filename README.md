# Harborline Operations

Harborline is a compact operations portal for coordinating shipments, stock,
team access, and reporting. It is dependency-light so it can be run locally or
in a small container without a build step.

## Run locally

```bash
npm start
```

Set `HARBORLINE_NORTH_ACCESS_CODE`, `HARBORLINE_SOUTH_ACCESS_CODE`, and
`HARBORLINE_SESSION_SECRET` through your environment or an untracked `.env`
file, then open `http://localhost:3000`. Account details are supplied by the
environment owner.

## Verify

```bash
npm run check
npm test
```

Application state is encrypted into each browser session. This keeps trials
isolated and portable across container instances without exposing state to the
browser. Starting a new browser session returns the application to its initial
state.

## Container

```bash
docker build -t harborline-ops .
docker run --rm --env-file .env -p 3000:3000 harborline-ops
```

## Vercel

Vercel builds the app from `Dockerfile.vercel`. Configure all variables from
`.env.example` in the Vercel project, then deploy. `HARBORLINE_RESET_TOKEN` is
optional and enables the owner-only reset endpoint used by the benchmark
harness.

## License

MIT
