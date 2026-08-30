# Harborline Operations

Harborline is a compact operations portal for coordinating shipments, stock,
team access, and reporting. It is dependency-light so it can be run locally or
in a small container without a build step.

## Run locally

```bash
npm start
```

Set `HARBORLINE_NORTH_ACCESS_CODE` and `HARBORLINE_SOUTH_ACCESS_CODE` through
your environment or an untracked `.env` file, then open `http://localhost:3000`.
Account details are supplied by the environment owner.

## Verify

```bash
npm run check
npm test
```

All application data is held in memory and returns to its initial state when
the process restarts.

## Container

```bash
docker build -t harborline-ops .
docker run --rm --env-file .env -p 3000:3000 harborline-ops
```

## License

MIT
