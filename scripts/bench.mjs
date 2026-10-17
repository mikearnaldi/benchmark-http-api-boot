// Cold-start benchmark runner.
//
//   node scripts/bench.mjs [--sizes 1x5,10x10,50x10,100x10] [--runs 30]
//                          [--effect-pkg ../effect/packages/effect]  (built: has dist/)
//                          [--label name] [--minify] [--openapi]
//                          [--warm N] [--compile-cache] [--server]
//
// --server         real cold start: spawn a node:http server (via
//                  @effect/platform-node), wait until it listens, send one HTTP
//                  request over loopback, measure spawn → response received
//
// --warm N         also rebuild define/build/request N times in-process after
//                  the cold pass and report the last (warm) iteration
// --compile-cache  enable Node's on-disk V8 code cache (NODE_COMPILE_CACHE);
//                  the warmup runs populate it, measured runs read it
//
// For every size: generate the API, bundle it, then spawn `--runs` fresh node
// processes (sequentially, after 2 discarded warmup runs for the OS file cache)
// and report median / p95 of every phase. Results are written to results/.
import { execFileSync, spawn } from "node:child_process"
import * as http from "node:http"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { bundle } from "./bundle.mjs"
import { parseSize, writeApi } from "./generate.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

const { values: opts } = parseArgs({
  options: {
    sizes: { type: "string", default: "1x1,1x5,10x10,25x10,50x10,100x10" },
    runs: { type: "string", default: "30" },
    "effect-pkg": { type: "string" },
    label: { type: "string" },
    minify: { type: "boolean", default: false },
    openapi: { type: "boolean", default: false },
    out: { type: "string" },
    warm: { type: "string", default: "0" },
    "compile-cache": { type: "boolean", default: false },
    server: { type: "boolean", default: false }
  }
})

const runs = Number(opts.runs)
const label = opts.label ?? (opts["effect-pkg"] ? "local" : "npm")
const env = { ...process.env, BENCH_OPENAPI: opts.openapi ? "1" : "0", BENCH_WARM: opts.warm }
delete env.NODE_COMPILE_CACHE
delete env.NODE_OPTIONS
const compileCacheRoot = opts["compile-cache"] ? mkdtempSync(join(tmpdir(), "bench-compile-cache-")) : undefined

const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b)
  const i = (s.length - 1) * q
  const lo = Math.floor(i)
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo)
}

// One cache dir per bundle so sizes never share entries.
const envFor = (file) => compileCacheRoot ? { ...env, NODE_COMPILE_CACHE: join(compileCacheRoot, file.replace(/[^a-z0-9]/gi, "_")) } : env
const runProcess = async (file) => JSON.parse(execFileSync(process.execPath, [file], { env: envFor(file), encoding: "utf8" }))

// Server mode: everything is timed from just before spawn() in this (warm)
// parent process. `ready` lines from a server trigger one GET; an empty script
// (baseline) only prints a ready line without a port.
// Same route the in-process harness hits: GET /r0/1, or the list route for
// 1-endpoint groups (which have no /r0/:id).
const pathFor = (file) => (/api-\d+x1\.mjs$/.test(file) ? "/r0" : "/r0/1")
const runServer = (file) => new Promise((resolve, _reject) => {
  const t0 = performance.now()
  const child = spawn(process.execPath, [file], { env: envFor(file), stdio: ["ignore", "pipe", "inherit"] })
  const out = {}
  let buf = ""
  let pending = 2
  const done = () => {
    if (--pending > 0) return
    child.kill()
    resolve(out)
  }
  const reject = (err) => {
    child.kill()
    _reject(err)
  }
  const timer = setTimeout(() => reject(new Error(`${file}: timed out`)), 30_000)
  child.on("exit", () => clearTimeout(timer))
  child.stdout.on("data", (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      if (msg.ready) {
        const tReady = performance.now()
        Object.assign(out, msg, { spawnReady: tReady - t0 })
        delete out.ready
        delete out.port
        if (!msg.port) {
          pending = 1
          done()
          continue
        }
        http.get({ host: "127.0.0.1", port: msg.port, path: pathFor(file), agent: false }, (res) => {
          res.resume()
          res.on("end", () => {
            if (res.statusCode !== 200) return reject(new Error(`${file}: status ${res.statusCode}`))
            const tEnd = performance.now()
            out.rtt = tEnd - tReady
            out.coldStart = tEnd - t0
            done()
          })
        }).on("error", reject)
      } else if (msg.served) {
        delete msg.served
        Object.assign(out, msg)
        done()
      }
    }
  })
})
const runOne = opts.server ? runServer : runProcess

const sample = async (file) => {
  await runOne(file)
  await runOne(file)
  const samples = []
  for (let i = 0; i < runs; i++) samples.push(await runOne(file))
  const stats = {}
  for (const key of Object.keys(samples[0])) {
    const xs = samples.map((s) => s[key])
    stats[key] = { median: quantile(xs, 0.5), p95: quantile(xs, 0.95), min: Math.min(...xs) }
  }
  return { stats, samples }
}

// Node bootstrap cost with no code at all, to subtract from `eval`.
const emptyFile = join(root, "dist", "empty.mjs")
mkdirSync(dirname(emptyFile), { recursive: true })
writeFileSync(emptyFile, opts.server
  ? `process.stdout.write(JSON.stringify({ ready: true, eval: performance.now() }) + "\\n")`
  : `process.stdout.write(JSON.stringify({ eval: performance.now() }))`)
const baselineStats = (await sample(emptyFile)).stats
const nodeBaseline = baselineStats.eval.median
// Server mode: spawn → first stdout line of an empty script (fork/exec + boot + pipe).
const spawnBaseline = opts.server ? baselineStats.spawnReady.median : undefined

console.log(`node ${process.version} | effect: ${opts["effect-pkg"] ?? "npm"} | runs: ${runs} | node bootstrap: ${nodeBaseline.toFixed(1)}ms\n`)

const results = []
for (const sizeStr of opts.sizes.split(",")) {
  const size = parseSize(sizeStr)
  const apiFile = writeApi(size)
  const { outFile, bytes } = await bundle({
    apiFile,
    outFile: join(root, "dist", label, `api-${sizeStr}.mjs`),
    effectPkg: opts["effect-pkg"],
    minify: opts.minify,
    mode: opts.server ? "server" : "handler"
  })
  const { stats, samples } = await sample(outFile)
  results.push({ size: sizeStr, endpoints: size.groups * size.endpoints, bundleKB: bytes / 1024, stats, samples })
  process.stderr.write(`  ${sizeStr} done\n`)
}

const fmt = (s) => `${s.median.toFixed(1)} (${s.p95.toFixed(1)})`
if (opts.server) {
  console.log(`median ms (p95) — spawn baseline (empty script): ${spawnBaseline.toFixed(1)}ms\n`)
  console.table(Object.fromEntries(results.map((r) => [`${r.size} (${r.endpoints} ep)`, {
    "bundle KB": Math.round(r.bundleKB),
    ...Object.fromEntries(["eval", "define", "layer", "listen", "spawnReady", "request", "rtt", "coldStart", "cpuAtResponse"].map((p) => [p, fmt(r.stats[p])]))
  }])))
  mkdirSync(join(root, "results"), { recursive: true })
  const out = opts.out ?? join(root, "results", `${label}-server-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
  writeFileSync(out, JSON.stringify({ node: process.version, effect: opts["effect-pkg"] ?? "npm", mode: "server", runs, nodeBaseline, spawnBaseline, results }, null, 2))
  console.log(`\nwrote ${out}`)
  process.exit(0)
}
const phases = ["eval", "define", "layer", "handler", "first", "second", ...(opts.openapi ? ["openapi"] : []), "total", "cpuTotal"]
console.log("median ms (p95)  —  eval includes node bootstrap; 'eval-node' subtracts it\n")
console.table(Object.fromEntries(results.map((r) => [
  `${r.size} (${r.endpoints} ep)`,
  {
    "bundle KB": Math.round(r.bundleKB),
    "eval-node": (r.stats.eval.median - nodeBaseline).toFixed(1),
    ...Object.fromEntries(phases.map((p) => [p, fmt(r.stats[p])])),
    // Time after module eval until the first response is out.
    "init→1st resp": ["define", "layer", "handler", "first"].reduce((n, k) => n + r.stats[k].median, 0).toFixed(1),
    "heap MB": r.stats.heapUsedMB.median.toFixed(1)
  }
])))

// Marginal cost per endpoint from the two largest sizes (least noisy slope).
if (results.length >= 2) {
  const [a, b] = results.slice(-2)
  const per = (k) => ((b.stats[k].median - a.stats[k].median) / (b.endpoints - a.endpoints) * 1000).toFixed(0)
  console.log(`\nmarginal cost per endpoint (${a.size} → ${b.size}): define ${per("define")}µs, handler ${per("handler")}µs, first ${per("first")}µs, total ${per("total")}µs`)
}

mkdirSync(join(root, "results"), { recursive: true })
const out = opts.out ?? join(root, "results", `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
writeFileSync(out, JSON.stringify({ node: process.version, effect: opts["effect-pkg"] ?? "npm", runs, nodeBaseline, results }, null, 2))
console.log(`\nwrote ${out}`)
