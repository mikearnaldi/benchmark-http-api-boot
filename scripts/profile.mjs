// CPU-profiles a single cold start and summarizes where the time goes.
//
//   node scripts/profile.mjs [--size 100x10] [--effect-pkg <path>] [--top 30]
//
// Writes profiles/<label>-<size>.cpuprofile (open it in Chrome DevTools or
// speedscope) and prints self-time aggregated by original source file and by
// function, mapped through the bundle's sourcemap. Only samples taken after
// module evaluation are included unless --include-eval is passed.
import { execFileSync } from "node:child_process"
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs"
import { SourceMap } from "node:module"
import { dirname, join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { bundle } from "./bundle.mjs"
import { parseSize, writeApi } from "./generate.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const { values: opts } = parseArgs({
  options: {
    size: { type: "string", default: "100x10" },
    "effect-pkg": { type: "string" },
    label: { type: "string" },
    top: { type: "string", default: "30" },
    "include-eval": { type: "boolean", default: false },
    interval: { type: "string", default: "50" }
  }
})
const label = opts.label ?? (opts["effect-pkg"] ? "local" : "npm")
const top = Number(opts.top)

const apiFile = writeApi(parseSize(opts.size))
const { outFile } = await bundle({
  apiFile,
  outFile: join(root, "dist", "profile", label, `api-${opts.size}.mjs`),
  effectPkg: opts["effect-pkg"],
  sourcemap: true
})

const tmp = join(root, "profiles", ".tmp")
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })
const timings = JSON.parse(execFileSync(process.execPath, [
  "--cpu-prof",
  `--cpu-prof-dir=${tmp}`,
  `--cpu-prof-interval=${opts.interval}`,
  outFile
], { encoding: "utf8" }))
const profFile = join(root, "profiles", `${label}-${opts.size}.cpuprofile`)
renameSync(join(tmp, readdirSync(tmp)[0]), profFile)
rmSync(tmp, { recursive: true })

const profile = JSON.parse(readFileSync(profFile, "utf8"))
const map = new SourceMap(JSON.parse(readFileSync(outFile + ".map", "utf8")))
const bundleUrl = pathToFileURL(outFile).href

const nodes = new Map(profile.nodes.map((n) => [n.id, n]))
const where = (frame) => {
  if (frame.url !== bundleUrl) {
    return { file: frame.url ? `(node) ${frame.url.replace(/^node:/, "")}` : `(${frame.functionName || "program"})`, fn: frame.functionName || "(anonymous)" }
  }
  const e = map.findEntry(frame.lineNumber, frame.columnNumber)
  const src = e?.originalSource ? e.originalSource.replace(/^file:\/\//, "") : "(bundle)"
  const file = src.includes("/effect/") ? src.slice(src.lastIndexOf("/effect/") + 1) : relative(root, src)
  return { file, fn: `${frame.functionName || "(anonymous)"} ${file.split("/").pop()}:${(e?.originalLine ?? 0) + 1}` }
}

// Cut at the first sample inside the generated `defineApi` call, i.e. after
// module evaluation (profile timestamps don't line up with performance.now()).
for (const n of profile.nodes) for (const c of n.children ?? []) nodes.get(c).parent = n.id
const isInDefine = (id) => {
  for (let n = nodes.get(id); n; n = nodes.get(n.parent)) {
    if (n.callFrame.functionName === "defineApi") return true
  }
  return false
}
const startIdx = opts["include-eval"] ? 0 : Math.max(0, profile.samples.findIndex(isInDefine))

const byFile = new Map()
const byFn = new Map()
let totalUs = 0
for (let i = startIdx; i < profile.samples.length; i++) {
  const dt = profile.timeDeltas[i + 1] ?? 0
  const { file, fn } = where(nodes.get(profile.samples[i]).callFrame)
  if (file === "(idle)") continue
  totalUs += dt
  byFile.set(file, (byFile.get(file) ?? 0) + dt)
  byFn.set(fn, (byFn.get(fn) ?? 0) + dt)
}

const print = (title, m) => {
  console.log(`\n${title}`)
  const rows = [...m].sort((a, b) => b[1] - a[1]).slice(0, top)
  for (const [k, us] of rows) {
    console.log(`  ${(us / 1000).toFixed(1).padStart(7)}ms ${((us / totalUs) * 100).toFixed(1).padStart(5)}%  ${k}`)
  }
}

console.log(`size ${opts.size} | phases: ${Object.entries(timings).map(([k, v]) => `${k}=${v.toFixed(1)}`).join(" ")}`)
console.log(`profiled ${opts["include-eval"] ? "whole process" : "from defineApi() onward"}: ${(totalUs / 1000).toFixed(1)}ms of samples (profiler overhead inflates absolute numbers)`)
print("self time by source file", byFile)
print("self time by function", byFn)
console.log(`\nprofile: ${profFile}`)
