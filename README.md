# HttpApi cold-start benchmark

**📊 Latest report: https://mikearnaldi.github.io/benchmark-http-api-boot/**
(published from `reports/` by `.github/workflows/pages.yml` on every push to `main`)

Measures the cold start of an `effect/http-api` app (Effect v4), i.e. **start the
server and answer one request**, as a function of API size. Every sample is a
brand new `node` process running a single rolldown bundle. Two modes:

- **Server** (`bench.mjs --server`, headline): `scripts/harness-server.mjs` runs
  `HttpRouter.serve` on `@effect/platform-node`'s `NodeHttpServer`. The runner
  spawns it, waits for its "listening" line, sends one HTTP `GET` over loopback and
  measures spawn → response received (plus the server's own phase times).
- **Web handler** (default): `scripts/harness.mjs` builds
  `HttpRouter.toWebHandler` (Worker-style, platform-neutral bundle) and passes one
  `Request` in-process. Used for phase-level CPU profiles and the cold/warm split.

## What gets measured

`scripts/generate.mjs` writes a synthetic API of `<groups>x<endpoints>`. Each
group is a REST resource with an entity schema (ints, strings, literals,
optionals, arrays, a nested struct), create/update payloads, a `TaggedError`
404, a 409 struct error, and endpoints `list` / `get` / `create` / `update` /
`remove` + `actionN` endpoints with their own schemas beyond the first 5.

Web-handler mode reports per phase (ms):

| phase     | what                                                                 |
|-----------|----------------------------------------------------------------------|
| `eval`    | process start → first harness line (node bootstrap + bundle parse/eval) |
| `eval-node` | `eval` minus an empty-script node bootstrap = library + module eval |
| `define`  | `HttpApi.make(...).add(HttpApiGroup...)` incl. schema construction   |
| `layer`   | `HttpApiBuilder.group(...)` x N + `HttpApiBuilder.layer(Api)` values |
| `handler` | `HttpRouter.toWebHandler(layer)`: builds the layer, all handler routes, router tree |
| `first`   | first `GET /r0/1` through the web handler                            |
| `second`  | second request (steady-state reference)                              |
| `openapi` | `OpenApi.fromApi(Api)` (only with `--openapi`)                       |
| `cpuTotal`| process CPU (user+sys, all threads incl. GC/compiler)                |

`init→1st resp` = define + layer + handler + first: the per-isolate cost that
sits on top of module eval for a Worker's first request.

## Usage

```sh
pnpm install
node scripts/bench.mjs --server                          # real cold start: spawn node:http server + 1 HTTP request
node scripts/bench.mjs                                   # web-handler mode (in-process request), 30 runs each
node scripts/bench.mjs --sizes 10x10,100x10 --runs 50 --openapi --minify
node scripts/bench.mjs --sizes 10x10 --warm 5               # + in-process warm rebuilds: cold-code penalty
node scripts/bench.mjs --sizes 10x10 --compile-cache         # with Node's on-disk V8 code cache
node scripts/profile.mjs --size 100x10                   # CPU profile, self time by file/function
node scripts/profile.mjs --size 100x10 --include-eval    # include module evaluation

# A/B a change in the Effect repo: build it, then point at the package dir (or a .tgz).
# The dir is `pnpm pack`ed so publishConfig applies, i.e. the same dist/ an npm user gets.
(cd ~/effect/packages/effect && pnpm build)
node scripts/bench.mjs --effect-pkg ~/effect/packages/effect --label before
# ...edit / checkout branch...
(cd ~/effect/packages/effect && pnpm build)
node scripts/bench.mjs --effect-pkg ~/effect/packages/effect --label after
node scripts/compare.mjs results/before-*.json results/after-*.json
```

### HTML report

```sh
node scripts/collect.mjs                 # server cold start, web-handler timings (normal/minified/warm/compile-cache) + CPU profiles → reports/data.json
node scripts/experiment-undici.mjs       # A/B of the undici triggers (FormData ref, ESM import of node:http)
node scripts/render-report.mjs           # → reports/report.html (self-contained, light/dark)
```

`collect.mjs` takes `--sizes` (default `1x1,1x10,5x10,10x10,50x10` = 1/10/50/100/500
endpoints), `--runs`, `--profile-runs` and `--effect-pkg`.

Profiles land in `profiles/*.cpuprofile` (open in Chrome DevTools / speedscope).
Samples are mapped back to Effect's `.ts` sources through the bundle sourcemap.

## Caveats

- Effect is always consumed as a published package (`dist/` via package.json
  `exports`, with the build-time `/*#__PURE__*/` annotations), never bundled
  from `src/` — that would add ~350 KB and ~20ms of eval a real app never pays.
- Bundling uses rolldown (`platform: "neutral"`, single chunk, JSDoc comments
  stripped). `--minify` uses rolldown's built-in Oxc minifier.
- Runs are sequential with 2 warmups per size; keep the machine quiet. Node's
  compile cache is disabled (`NODE_COMPILE_CACHE` is unset).
- Node ≠ workerd. V8 is the same, but absolute numbers will differ; the
  scaling per endpoint and the profile hotspots are what carry over.
