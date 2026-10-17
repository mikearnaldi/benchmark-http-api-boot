// Collects everything the HTML report needs into reports/data.json.
//
//   node scripts/collect.mjs [--sizes 1x1,1x10,5x10,10x10,50x10] [--runs 30]
//                            [--profile-runs 5] [--effect-pkg <dir|tgz>]
//
// 1. Timings: bench.mjs (fresh process per sample) for the normal and the
//    minified bundle, with OpenApi.fromApi timed as an extra phase.
// 2. Attribution: `--profile-runs` CPU-profiled cold starts per size. Every
//    sample is assigned to a phase using the harness' monotonic marks (same
//    clock as V8's profiler), and to a category via the bundle sourcemap.
// 3. Bundle composition: rendered bytes per category from the bundle metadata.
import { execFileSync } from "node:child_process"
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { SourceMap } from "node:module"
import { cpus, platform, release } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { bundle } from "./bundle.mjs"
import { parseSize, writeApi } from "./generate.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const { values: opts } = parseArgs({
  options: {
    sizes: { type: "string", default: "1x1,1x10,5x10,10x10,50x10" },
    runs: { type: "string", default: "30" },
    "profile-runs": { type: "string", default: "5" },
    "effect-pkg": { type: "string" },
    interval: { type: "string", default: "100" }
  }
})
const sizes = opts.sizes.split(",")
const outDir = join(root, "reports")
mkdirSync(outDir, { recursive: true })

// ---------------------------------------------------------------- timings
const bench = (label, extra) => {
  const out = join(outDir, `bench-${label}.json`)
  execFileSync(process.execPath, [
    join(root, "scripts", "bench.mjs"),
    "--sizes", opts.sizes, "--runs", opts.runs, "--openapi", "--label", `report-${label}`, "--out", out,
    ...(opts["effect-pkg"] ? ["--effect-pkg", opts["effect-pkg"]] : []),
    ...extra
  ], { stdio: ["ignore", "inherit", "inherit"] })
  return JSON.parse(readFileSync(out, "utf8"))
}
console.log("== timings (normal bundle)")
const timings = bench("normal", [])
console.log("== timings (minified bundle)")
const timingsMin = bench("minified", ["--minify"])

// ---------------------------------------------------------------- categories
// Ordered: first match wins.
const CATEGORIES = [
  ["Router (FindMyWay)", (f) => f.includes("/http/FindMyWay/")],
  ["HttpApiBuilder", (f) => f.includes("/http-api/HttpApiBuilder")],
  ["HttpApi definition", (f) => f.includes("/http-api/")],
  ["Schema", (f) => /\/(Schema[A-Za-z]*\.ts|internal\/schema\/)/.test(f)],
  ["Effect runtime & Layer", (f) => /\/(internal\/(effect|core|layer|context|fiber|scheduler)[^/]*|Effect|Layer|Context|Scope|Fiber|Exit|Cause|ServiceMap|Scheduler|Ref|Deferred)\.ts$/.test(f) || /\/internal\/(effect|core)/.test(f)],
  ["pipe / dual / predicates", (f) => /\/(Function|Pipeable|Predicate|Equal|Hash|Inspectable|Utils)\.ts$/.test(f)],
  ["Garbage collector", (f) => f === "(garbage collector)"],
  // Node lazily initializes undici the first time Request/Response/Headers/
  // FormData is touched; workerd has these natively, so it's Node-only cost.
  ["Node: undici init", (f) => f.startsWith("node:internal/deps/undici")],
  ["Node built-ins", (f) => f.startsWith("node:")],
  ["Module top-level (unmapped)", (f) => f === "(bundle)"],
  ["V8 (program)", (f) => f === "(program)"],
  ["Other", () => true]
]
const categoryOf = (file) => CATEGORIES.find(([, test]) => test(file))[0]

// ---------------------------------------------------------------- profiles
const PHASES = ["bootstrap", "eval", "define", "layer", "handler", "first", "second", "openapi"]
const phaseOf = (ts, m) => {
  if (ts < m.evalEnd) return "eval" // refined below for node bootstrap
  if (ts < m.define) return "define"
  if (ts < m.layer) return "layer"
  if (ts < m.handler) return "handler"
  if (ts < m.first) return "first"
  if (ts < m.second) return "second"
  if (ts < m.openapi) return "openapi"
  return null
}

const profileSize = async (size) => {
  const apiFile = writeApi(parseSize(size))
  const { outFile } = await bundle({
    apiFile,
    outFile: join(root, "dist", "report-profile", `api-${size}.mjs`),
    effectPkg: opts["effect-pkg"],
    sourcemap: true
  })
  const map = new SourceMap(JSON.parse(readFileSync(outFile + ".map", "utf8")))
  const bundleUrl = pathToFileURL(outFile).href
  const locCache = new Map()
  const locate = (frame) => {
    if (frame.url !== bundleUrl) {
      if (!frame.url) return { file: frame.functionName === "(garbage collector)" ? "(garbage collector)" : `(${frame.functionName || "program"})`, line: 0 }
      return { file: `node:${frame.url.replace(/^node:/, "")}`, line: 0 }
    }
    const key = `${frame.lineNumber}:${frame.columnNumber}`
    if (!locCache.has(key)) {
      const e = map.findEntry(frame.lineNumber, frame.columnNumber)
      const src = e?.originalSource ? e.originalSource.replace(/^file:\/\//, "") : "(bundle)"
      const file = src.includes("/effect/") ? src.slice(src.lastIndexOf("/effect/") + 1) : relative(root, src)
      locCache.set(key, { file, line: (e?.originalLine ?? 0) + 1 })
    }
    return locCache.get(key)
  }

  // acc[phase][category] = µs ; fns[phase][fn] = µs ; files.eval[file] = µs
  const acc = Object.fromEntries(PHASES.map((p) => [p, {}]))
  const fns = Object.fromEntries(PHASES.map((p) => [p, {}]))
  const evalFiles = {}
  const runs = Number(opts["profile-runs"])
  const tmp = join(root, "profiles", ".collect")
  for (let r = 0; r < runs; r++) {
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { recursive: true })
    const out = JSON.parse(execFileSync(process.execPath, [
      "--cpu-prof", `--cpu-prof-dir=${tmp}`, `--cpu-prof-interval=${opts.interval}`, outFile
    ], { encoding: "utf8", env: { ...process.env, BENCH_MARKS: "1", BENCH_OPENAPI: "1" } }))
    const prof = JSON.parse(readFileSync(join(tmp, readdirSync(tmp)[0]), "utf8"))
    const nodes = new Map(prof.nodes.map((n) => [n.id, n]))
    for (const n of prof.nodes) for (const c of n.children ?? []) nodes.get(c).parent = n.id
    // Classify pre-harness samples: bundle code on the stack -> module
    // evaluation; under the ESM loader's compile step -> parsing/compiling the
    // bundle; anything else -> node's own startup.
    const evalKind = new Map()
    const kindOf = (id) => {
      if (evalKind.has(id)) return evalKind.get(id)
      const n = nodes.get(id)
      const f = n.callFrame
      const own = f.url === bundleUrl ? "module" : (f.functionName === "compileSourceTextModule" || f.functionName === "ModuleWrap") ? "compile" : null
      const v = own ?? (n.parent !== undefined ? kindOf(n.parent) : null)
      evalKind.set(id, v)
      return v
    }
    // undici pulls in crypto/zlib/net/streams while initializing; charge those
    // node: frames to undici when an undici frame is on the stack.
    const undiciMemo = new Map()
    const underUndici = (id) => {
      if (undiciMemo.has(id)) return undiciMemo.get(id)
      const n = nodes.get(id)
      const v = n.callFrame.url.startsWith("node:internal/deps/undici") || (n.parent !== undefined && underUndici(n.parent))
      undiciMemo.set(id, v)
      return v
    }
    const firstBundleTs = (() => {
      let t = prof.startTime
      for (let i = 0; i < prof.samples.length; i++) {
        t += prof.timeDeltas[i]
        if (kindOf(prof.samples[i])) return t
      }
      return Infinity
    })()
    let ts = prof.startTime
    for (let i = 0; i < prof.samples.length; i++) {
      ts += prof.timeDeltas[i]
      const dt = prof.timeDeltas[i + 1] ?? 0
      const id = prof.samples[i]
      const frame = nodes.get(id).callFrame
      if (frame.functionName === "(idle)") continue
      let phase = phaseOf(ts, out.marks)
      if (!phase) continue
      const { file, line } = locate(frame)
      let cat
      if (phase === "eval") {
        const kind = kindOf(id)
        if (kind === "compile") cat = "Parse & compile bundle"
        else if (kind === "module") cat = categoryOf(file)
        // Stackless samples (GC, "(program)") belong to whatever was running.
        else if (!nodes.get(id).parent || nodes.get(nodes.get(id).parent).callFrame.functionName === "(root)") {
          if (ts < firstBundleTs) phase = "bootstrap"
          cat = phase === "bootstrap" ? "Node bootstrap" : categoryOf(file)
        } else {
          phase = "bootstrap"
          cat = "Node bootstrap"
        }
      } else {
        cat = categoryOf(file)
      }
      if (file.startsWith("node:") && underUndici(id) && phase !== "bootstrap") cat = "Node: undici init"
      acc[phase][cat] = (acc[phase][cat] ?? 0) + dt / runs
      const fn = `${frame.functionName || "(anonymous)"} ${file.split("/").slice(-2).join("/")}${line ? `:${line}` : ""}`
      fns[phase][fn] = (fns[phase][fn] ?? 0) + dt / runs
      if (phase === "eval") evalFiles[file] = (evalFiles[file] ?? 0) + dt / runs
    }
  }
  rmSync(tmp, { recursive: true, force: true })
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, us]) => ({ name: k, ms: us / 1000 }))
  return {
    size,
    categoriesMs: Object.fromEntries(PHASES.map((p) => [p, Object.fromEntries(Object.entries(acc[p]).map(([c, us]) => [c, us / 1000]))])),
    topFunctions: Object.fromEntries(PHASES.map((p) => [p, top(fns[p], 15)])),
    evalFiles: top(evalFiles, 20),
    bundleMeta: JSON.parse(readFileSync(outFile + ".meta.json", "utf8"))
  }
}

console.log("== profiles")
const profiles = []
for (const size of sizes) {
  profiles.push(await profileSize(size))
  console.log(`  ${size} profiled`)
}

// ---------------------------------------------------------------- bundle composition
const composition = (meta) => {
  const out = {}
  const inputs = Object.values(meta.outputs)[0].inputs
  for (const [id, { bytesInOutput }] of Object.entries(inputs)) {
    const file = id.includes("/effect/") ? id.slice(id.lastIndexOf("/effect/") + 1).replace("/dist/", "/src/").replace(/\.js$/, ".ts") : relative(root, id)
    const cat = file.startsWith("generated/") ? "App code (generated API)" : file.startsWith("scripts/") ? "Harness" : categoryOf(file)
    out[cat] = (out[cat] ?? 0) + bytesInOutput
  }
  return out
}

const data = {
  generatedAt: new Date().toISOString(),
  env: {
    node: process.version,
    platform: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
    effect: opts["effect-pkg"] ?? `npm ${JSON.parse(readFileSync(join(root, "node_modules", "effect", "package.json"), "utf8")).version}`,
    rolldown: JSON.parse(readFileSync(join(root, "node_modules", "rolldown", "package.json"), "utf8")).version,
    runs: Number(opts.runs),
    profileRuns: Number(opts["profile-runs"]),
    profileIntervalUs: Number(opts.interval)
  },
  sizes: sizes.map((s) => ({ size: s, ...parseSize(s), total: parseSize(s).groups * parseSize(s).endpoints })),
  timings: { ...timings, results: timings.results.map(({ samples, ...r }) => r) },
  timingsMin: { ...timingsMin, results: timingsMin.results.map(({ samples, ...r }) => r) },
  profiles: profiles.map(({ bundleMeta, ...p }) => ({ ...p, bundleBytesByCategory: composition(bundleMeta) }))
}
writeFileSync(join(outDir, "data.json"), JSON.stringify(data, null, 2))
console.log(`wrote ${join(outDir, "data.json")}`)
