// Cold-start benchmark runner.
//
//   node scripts/bench.mjs [--sizes 1x5,10x10,50x10,100x10] [--runs 30]
//                          [--effect-pkg ../effect/packages/effect]  (built: has dist/)
//                          [--label name] [--minify] [--openapi]
//
// For every size: generate the API, bundle it, then spawn `--runs` fresh node
// processes (sequentially, after 2 discarded warmup runs for the OS file cache)
// and report median / p95 of every phase. Results are written to results/.
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
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
    out: { type: "string" }
  }
})

const runs = Number(opts.runs)
const label = opts.label ?? (opts["effect-pkg"] ? "local" : "npm")
const env = { ...process.env, BENCH_OPENAPI: opts.openapi ? "1" : "0" }
delete env.NODE_COMPILE_CACHE
delete env.NODE_OPTIONS

const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b)
  const i = (s.length - 1) * q
  const lo = Math.floor(i)
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo)
}

const runProcess = (file) => JSON.parse(execFileSync(process.execPath, [file], { env, encoding: "utf8" }))

const sample = (file) => {
  runProcess(file)
  runProcess(file)
  const samples = []
  for (let i = 0; i < runs; i++) samples.push(runProcess(file))
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
writeFileSync(emptyFile, `process.stdout.write(JSON.stringify({ eval: performance.now() }))`)
const nodeBaseline = sample(emptyFile).stats.eval.median

console.log(`node ${process.version} | effect: ${opts["effect-pkg"] ?? "npm"} | runs: ${runs} | node bootstrap: ${nodeBaseline.toFixed(1)}ms\n`)

const results = []
for (const sizeStr of opts.sizes.split(",")) {
  const size = parseSize(sizeStr)
  const apiFile = writeApi(size)
  const { outFile, bytes } = await bundle({
    apiFile,
    outFile: join(root, "dist", label, `api-${sizeStr}.mjs`),
    effectPkg: opts["effect-pkg"],
    minify: opts.minify
  })
  const { stats, samples } = sample(outFile)
  results.push({ size: sizeStr, endpoints: size.groups * size.endpoints, bundleKB: bytes / 1024, stats, samples })
  process.stderr.write(`  ${sizeStr} done\n`)
}

const phases = ["eval", "define", "layer", "handler", "first", "second", ...(opts.openapi ? ["openapi"] : []), "total", "cpuTotal"]
const fmt = (s) => `${s.median.toFixed(1)} (${s.p95.toFixed(1)})`
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
