// Renders reports/report.html: a cold-start report for effect/http-api.
// Inputs: reports/data.json, reports/bench-*.json (with samples) and
// reports/experiment-undici.json. Self-contained: inline CSS/JS/SVG.
//
//   node scripts/render-report.mjs
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (f) => JSON.parse(readFileSync(join(root, "reports", f), "utf8"))
const data = read("data.json")
const raw = read("bench-normal.json")
const rawWarm = read("bench-warm.json")
const rawServer = read("bench-server.json")
const expU = existsSync(join(root, "reports", "experiment-undici.json")) ? read("experiment-undici.json") : null
// Web-handler view of the undici experiment (FormData reference only).
const exp = expU && { size: expU.size, runs: expU.runs, baseline: expU.handler.baseline, withoutFormData: expU.handler.withoutFormData, emptyProcessFormDataTouchMs: expU.isolated.touchFormDataMs }

// ------------------------------------------------------------------ stats
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b)
  const i = (s.length - 1) * q
  const lo = Math.floor(i)
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo)
}
const fit = (xs, ys) => {
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b) / n
  const my = ys.reduce((a, b) => a + b) / n
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my)
    sxx += (xs[i] - mx) ** 2
    syy += (ys[i] - my) ** 2
  }
  const slope = sxy / sxx
  return { slope, intercept: my - slope * mx, r2: syy === 0 ? 1 : (sxy * sxy) / (sxx * syy) }
}
const summarize = (samples, derive) => {
  const ds = samples.map(derive)
  const keys = Object.keys(ds[0])
  return {
    med: Object.fromEntries(keys.map((k) => [k, quantile(ds.map((d) => d[k]), 0.5)])),
    p95: Object.fromEntries(keys.map((k) => [k, quantile(ds.map((d) => d[k]), 0.95)]))
  }
}

const B = raw.nodeBaseline
const rows = raw.results.map((r) => ({
  size: r.size,
  endpoints: r.endpoints,
  bundleKB: r.bundleKB,
  ...summarize(r.samples, (s) => ({
    moduleLoad: s.eval - B,
    define: s.define,
    build: s.layer + s.handler,
    first: s.first,
    second: s.second,
    openapi: s.openapi,
    cold: s.eval + s.define + s.layer + s.handler + s.first,
    afterLoad: s.define + s.layer + s.handler + s.first,
    cpuCold: s.cpuColdStart,
    heap: s.heapUsedMB
  }))
}))
// Same-process cold vs warm (separate processes from `rows`, so compare within).
const warmRows = rawWarm.results.map((r) => ({
  size: r.size,
  endpoints: r.endpoints,
  ...summarize(r.samples, (s) => ({
    coldDefine: s.define,
    coldBuild: s.layer + s.handler,
    coldFirst: s.first,
    warmDefine: s.warmDefine,
    warmBuild: s.warmLayer + s.warmHandler,
    warmFirst: s.warmFirst,
    cold: s.define + s.layer + s.handler + s.first,
    warm: s.warmDefine + s.warmLayer + s.warmHandler + s.warmFirst
  }))
}))
// Real cold start: spawn a node:http server, one HTTP request over loopback.
const serverRows = rawServer.results.map((r) => ({
  size: r.size,
  endpoints: r.endpoints,
  bundleKB: r.bundleKB,
  ...summarize(r.samples, (s) => ({
    spawn: s.spawnReady - (s.eval + s.define + s.layer + s.listen),
    boot: B,
    moduleLoad: s.eval - B,
    define: s.define,
    build: s.layer + s.listen,
    request: s.rtt,
    serverRequest: s.request,
    coldStart: s.coldStart,
    ready: s.spawnReady,
    cpu: s.cpuAtResponse
  }))
}))
const SS = serverRows[0]
const SL = serverRows.at(-1)
const minRows = data.timingsMin.results
const cacheRows = data.timingsCache.results
const minB = data.timingsMin.nodeBaseline
const cacheB = data.timingsCache.nodeBaseline
const E = rows.map((r) => r.endpoints)
const fitOf = (list, key) => fit(E, list.map((r) => (key === "bundleKB" ? r.bundleKB : r.med[key])))
const fits = Object.fromEntries(["moduleLoad", "define", "build", "first", "cold", "afterLoad", "cpuCold", "heap", "bundleKB", "openapi"].map((k) => [k, fitOf(rows, k)]))
const serverFits = Object.fromEntries(["coldStart", "define", "build", "request", "moduleLoad", "cpu"].map((k) => [k, fit(E, serverRows.map((r) => r.med[k]))]))
const warmFits = { cold: fitOf(warmRows, "cold"), warm: fitOf(warmRows, "warm") }
const S = rows[0]
const L = rows.at(-1)
const WS = warmRows[0]
const WL = warmRows.at(-1)
const penalty = (w) => w.med.cold - w.med.warm
const penaltyShare = (w) => penalty(w) / w.med.cold

// ------------------------------------------------------------------ attribution (profiles)
const POST = ["Router (FindMyWay)", "HttpApiBuilder", "HttpApi definition", "Schema", "Effect runtime & Layer", "pipe / dual / predicates", "Garbage collector", "Other"]
const foldPost = (cat) => (POST.includes(cat) ? cat : "Other")
const LOAD = ["Parse & compile bundle", "Effect module evaluation", "Node: undici init", "Garbage collector / other"]
const foldLoad = (cat) => {
  if (cat === "Parse & compile bundle" || cat === "Node: undici init") return cat
  if (cat === "Garbage collector" || cat === "Node built-ins" || cat === "V8 (program)") return "Garbage collector / other"
  return "Effect module evaluation"
}
const fold = (cats, fn) => {
  const out = {}
  for (const [c, ms] of Object.entries(cats ?? {})) out[fn(c)] = (out[fn(c)] ?? 0) + ms
  return out
}
const add = (a, b) => {
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v
  return out
}
// Profile shares scaled to the un-profiled median (the profiler inflates time).
const scale = (cats, target) => {
  const sum = Object.values(cats).reduce((a, b) => a + b, 0)
  return Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, sum ? (v / sum) * target : 0]))
}
const attribution = data.profiles.map((p, i) => {
  const r = rows[i]
  const c = p.categoriesMs
  return {
    endpoints: r.endpoints,
    load: scale(fold(c.eval, foldLoad), r.med.moduleLoad),
    define: scale(fold(c.define, foldPost), r.med.define),
    build: scale(add(fold(c.layer, foldPost), fold(c.handler, foldPost)), r.med.build),
    first: scale(fold(c.first, foldPost), r.med.first)
  }
})
const perEndpoint = Object.fromEntries(["define", "build"].map((phase) => [
  phase,
  Object.fromEntries(POST.map((cat) => [cat, fit(E, attribution.map((a) => a[phase][cat] ?? 0)).slope * 1000]))
]))
const loadAvg = (() => {
  const out = {}
  for (const a of attribution) for (const [k, v] of Object.entries(a.load)) out[k] = (out[k] ?? 0) + v / attribution.length
  return out
})()
const bigProfile = data.profiles.at(-1)

const BYTES = ["Router (FindMyWay)", "HttpApi (definition + builder)", "Schema", "HTTP stack (effect/http)", "Stream / Channel", "Effect runtime & Layer", "Other Effect modules", "App code + harness"]
const byteCategory = (id) => {
  if (!id.includes("/effect/")) return "App code + harness"
  const f = id.slice(id.lastIndexOf("/effect/") + 8)
  if (f.includes("/http/FindMyWay/")) return "Router (FindMyWay)"
  if (f.startsWith("dist/http-api/")) return "HttpApi (definition + builder)"
  if (/^dist\/(Schema[A-Za-z]*\.js|internal\/schema\/)/.test(f)) return "Schema"
  if (f.startsWith("dist/http/")) return "HTTP stack (effect/http)"
  if (/^dist\/(Stream|Channel|Sink|Queue|PubSub|Take|internal\/(stream|channel))/.test(f)) return "Stream / Channel"
  if (/^dist\/(internal\/(effect|core|layer|context|fiber|scheduler)|Effect|Layer|Context|Scope|Fiber|Exit|Cause|Scheduler|Ref|Deferred)/.test(f)) return "Effect runtime & Layer"
  return "Other Effect modules"
}
const bytesFor = (size) => {
  const meta = JSON.parse(readFileSync(join(root, "dist", "report-profile", `api-${size}.mjs.meta.json`), "utf8"))
  const out = {}
  for (const [id, { bytesInOutput }] of Object.entries(Object.values(meta.outputs)[0].inputs)) {
    const c = byteCategory(id)
    out[c] = (out[c] ?? 0) + bytesInOutput / 1024
  }
  return out
}

// ------------------------------------------------------------------ formatting
const f1 = (x) => x.toFixed(1)
const f0 = (x) => Math.round(x).toLocaleString("en-US")
const pct = (a, b) => `${Math.round((a / b) * 100)}%`
const x1 = (a, b) => `${(a / b).toFixed(a / b >= 10 ? 0 : 1)}×`
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
const table = (head, body) => `<table><thead><tr>${head.map((h, i) => `<th${i ? ' class="num"' : ""}>${h}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ""}>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`
const details = (title, inner) => `<details><summary>${title}</summary>${inner}</details>`
const sumPer = (phase) => Object.values(perEndpoint[phase]).reduce((a, b) => a + b, 0)
const undiciMs = exp ? exp.baseline.eval - exp.withoutFormData.eval : loadAvg["Node: undici init"]
const minLoad = (i) => minRows[i].stats.eval.median - minB
const cacheLoad = (i) => cacheRows[i].stats.eval.median - cacheB
const loadOf = (i) => rows[i].med.moduleLoad
const avgSaving = (fn) => rows.reduce((n, _, i) => n + (loadOf(i) - fn(i)), 0) / rows.length
const minSaving = avgSaving(minLoad)
const cacheSaving = avgSaving(cacheLoad)

// ------------------------------------------------------------------ charts
const ANATOMY = [
  { key: "boot", label: "Node boot", color: "var(--neutral)" },
  { key: "compile", label: "Parse & compile bundle", color: "var(--s1)" },
  { key: "eval", label: "Module evaluation", color: "var(--s7)" },
  { key: "undici", label: "undici init (Node only)", color: "var(--neutral-2)" },
  { key: "define", label: "Define API", color: "var(--s2)" },
  { key: "build", label: "Build handler", color: "var(--s3)" },
  { key: "first", label: "First request", color: "var(--s4)" }
]
const anatomyOf = (r, a) => ({
  boot: B,
  compile: a.load["Parse & compile bundle"] ?? 0,
  eval: (a.load["Effect module evaluation"] ?? 0) + (a.load["Garbage collector / other"] ?? 0),
  undici: a.load["Node: undici init"] ?? 0,
  define: r.med.define,
  build: r.med.build,
  first: r.med.first
})
const CAT_SERIES = POST.map((k, i) => ({ key: k, label: k, color: `var(--s${i + 1})` }))
const LOAD_SERIES = [
  { key: "Parse & compile bundle", label: "Parse & compile bundle", color: "var(--s1)" },
  { key: "Effect module evaluation", label: "Effect module evaluation", color: "var(--s7)" },
  { key: "Node: undici init", label: "undici init (Node only)", color: "var(--neutral-2)" },
  { key: "Garbage collector / other", label: "GC / other", color: "var(--neutral)" }
]
const BYTE_SERIES = BYTES.map((k, i) => ({ key: k, label: k, color: `var(--s${i + 1})` }))
const COLDWARM = [
  { key: "warm", label: "Work (warm cost)", color: "var(--s3)" },
  { key: "penalty", label: "Cold-code penalty", color: "var(--s2)" }
]

const SERVER_ANATOMY = [
  { key: "spawn", label: "Spawn (fork/exec, ready signal)", color: "var(--neutral-2)" },
  { key: "boot", label: "Node boot", color: "var(--neutral)" },
  { key: "moduleLoad", label: "Module load", color: "var(--s1)" },
  { key: "define", label: "Define API", color: "var(--s2)" },
  { key: "build", label: "Build handler + listen", color: "var(--s3)" },
  { key: "request", label: "First HTTP request", color: "var(--s4)" }
]
const charts = {
  serverAnatomy: {
    type: "stack", unit: "ms", series: SERVER_ANATOMY,
    rows: serverRows.map((r) => ({ label: `${r.endpoints} endpoint${r.endpoints === 1 ? "" : "s"}`, values: Object.fromEntries(SERVER_ANATOMY.map((x) => [x.key, r.med[x.key]])) }))
  },
  undici: expU && {
    type: "stack", unit: "ms", series: [{ key: "cold", label: "Server cold start", color: "var(--s1)" }],
    rows: Object.entries(expU.server).map(([name, v]) => ({ label: name, values: { cold: v.coldStart } }))
  },
  anatomy: {
    type: "stack", unit: "ms", series: ANATOMY,
    rows: rows.map((r, i) => ({ label: `${r.endpoints} endpoint${r.endpoints === 1 ? "" : "s"}`, values: anatomyOf(r, attribution[i]) }))
  },
  coldWarm: {
    type: "stack", unit: "ms", series: COLDWARM,
    rows: warmRows.map((w) => ({ label: `${w.endpoints} ep`, values: { warm: w.med.warm, penalty: penalty(w) } }))
  },
  coldWarmLines: {
    type: "line", unit: "ms", x: E, xLabel: "endpoints",
    series: [
      { key: "cold", label: "Cold (first time)", color: "var(--s2)", values: warmRows.map((w) => w.med.cold) },
      { key: "warm", label: "Warm (same work, hot code)", color: "var(--s3)", values: warmRows.map((w) => w.med.warm) }
    ]
  },
  growth: {
    type: "line", unit: "ms", x: E, xLabel: "endpoints",
    series: [
      { key: "moduleLoad", label: "Module load", color: "var(--s1)", values: rows.map((r) => r.med.moduleLoad) },
      { key: "build", label: "Build handler", color: "var(--s3)", values: rows.map((r) => r.med.build) },
      { key: "define", label: "Define API", color: "var(--s2)", values: rows.map((r) => r.med.define) },
      { key: "first", label: "First request", color: "var(--s4)", values: rows.map((r) => r.med.first) }
    ]
  },
  perEndpoint: {
    type: "stack", unit: "µs", series: CAT_SERIES,
    rows: [{ label: "Define API", values: perEndpoint.define }, { label: "Build handler", values: perEndpoint.build }]
  },
  buildMix: { type: "stack", unit: "ms", series: CAT_SERIES, rows: attribution.map((a) => ({ label: `${a.endpoints} ep`, values: a.build })) },
  defineMix: { type: "stack", unit: "ms", series: CAT_SERIES, rows: attribution.map((a) => ({ label: `${a.endpoints} ep`, values: a.define })) },
  load: { type: "stack", unit: "ms", series: LOAD_SERIES, rows: [{ label: "Module load", values: loadAvg }] },
  levers: {
    type: "stack", unit: "ms", series: [{ key: "load", label: "Module load", color: "var(--s1)" }],
    rows: [
      { label: "As shipped", values: { load: S.med.moduleLoad } },
      { label: "Minified", values: { load: minLoad(0) } },
      { label: "Node compile cache", values: { load: cacheLoad(0) } },
      ...(exp ? [{ label: `No FormData at load (${exp.size})`, values: { load: exp.withoutFormData.eval - B } }] : [])
    ]
  },
  bundle: {
    type: "stack", unit: "KB", series: BYTE_SERIES,
    rows: [S, L].map((r) => ({ label: `${r.endpoints} ep`, values: bytesFor(r.size) }))
  }
}

// ------------------------------------------------------------------ tables
const tblAnatomy = table(
  ["Endpoints", "Node boot", "Parse & compile", "Module eval", "undici (Node)", "Define", "Build", "First request", "<b>Cold start p50</b>", "p95", "CPU (all threads)"],
  rows.map((r, i) => {
    const a = anatomyOf(r, attribution[i])
    return [r.endpoints, f1(a.boot), f1(a.compile), f1(a.eval), f1(a.undici), f1(a.define), f1(a.build), f1(a.first), `<b>${f1(r.med.cold)}</b>`, f1(r.p95.cold), f1(r.med.cpuCold)]
  })
)
const tblServer = table(
  ["Endpoints", "Spawn", "Node boot", "Module load", "Define", "Build + listen", "First HTTP request", "<b>Cold start p50</b>", "p95", "CPU (all threads)", "Bundle KB"],
  serverRows.map((r) => [r.endpoints, f1(r.med.spawn), f1(r.med.boot), f1(r.med.moduleLoad), f1(r.med.define), f1(r.med.build), f1(r.med.request), `<b>${f1(r.med.coldStart)}</b>`, f1(r.p95.coldStart), f1(r.med.cpu), f0(r.bundleKB)])
)
const tblUndici = expU && table(
  ["Server variant (" + expU.size + ")", "Module load", "Cold start", "undici loaded?"],
  Object.entries(expU.server).map(([name, v]) => [name, f1(v.moduleLoad - B), `<b>${f1(v.coldStart)}</b>`, v.undiciLoaded ? "yes" : "no"])
)
const undiciSaving = expU ? expU.server["As shipped"].coldStart - expU.server["Both removed"].coldStart : 0
const tblColdWarm = table(
  ["Endpoints", "Define cold / warm", "Build cold / warm", "First request cold / warm", "Total cold / warm", "Cold-code penalty"],
  warmRows.map((w) => [
    w.endpoints,
    `${f1(w.med.coldDefine)} / ${f1(w.med.warmDefine)} <span class="muted">(${x1(w.med.coldDefine, w.med.warmDefine)})</span>`,
    `${f1(w.med.coldBuild)} / ${f1(w.med.warmBuild)} <span class="muted">(${x1(w.med.coldBuild, w.med.warmBuild)})</span>`,
    `${f1(w.med.coldFirst)} / ${f1(w.med.warmFirst)} <span class="muted">(${x1(w.med.coldFirst, w.med.warmFirst)})</span>`,
    `${f1(w.med.cold)} / ${f1(w.med.warm)}`,
    `<b>${f1(penalty(w))} ms (${pct(penalty(w), w.med.cold)})</b>`
  ])
)
const tblGrowth = table(
  ["Endpoints", "Module load", "Define API", "Build handler", "First request", "Cold start", "CPU (all threads)", "Bundle KB"],
  rows.map((r) => [r.endpoints, f1(r.med.moduleLoad), f1(r.med.define), f1(r.med.build), f1(r.med.first), `<b>${f1(r.med.cold)}</b>`, f1(r.med.cpuCold), f0(r.bundleKB)])
)
const fitRow = (label, f, unit = "µs", icpt = "ms") => [label, `${f1(f.slope * (unit === "µs" ? 1000 : 1))} ${unit}`, `${f1(f.intercept)} ${icpt}`, f.r2.toFixed(3)]
const tblFits = table(
  ["", "Per endpoint", "Fixed", "R²"],
  [
    fitRow("<b>Cold start (wall)</b>", fits.cold),
    fitRow("Cold start (CPU, all threads)", fits.cpuCold),
    fitRow("Define API", fits.define),
    fitRow("Build handler", fits.build),
    fitRow("Module load", fits.moduleLoad),
    fitRow("First request", fits.first),
    fitRow("Define+build+first, warm", warmFits.warm),
    [`Bundle (unminified)`, `${f1(fits.bundleKB.slope)} KB`, `${f0(fits.bundleKB.intercept)} KB`, fits.bundleKB.r2.toFixed(3)]
  ]
)
const marginal = rows.slice(1).map((r, i) => {
  const a = rows[i]
  return [`${a.endpoints} → ${r.endpoints}`, f0(((r.med.afterLoad - a.med.afterLoad) / (r.endpoints - a.endpoints)) * 1000)]
})
const marginalRaw = rows.slice(1).map((r, i) => ((r.med.afterLoad - rows[i].med.afterLoad) / (r.endpoints - rows[i].endpoints)) * 1000)
const catTable = (phase) => table(
  ["Category", ...attribution.map((a) => `${a.endpoints} ep`), "µs / endpoint"],
  POST.map((c) => [c, ...attribution.map((a) => f1(a[phase][c] ?? 0)), f1(perEndpoint[phase][c])])
)
const tblPerEndpoint = table(
  ["Category", "Define API µs/ep", "Build handler µs/ep"],
  [...POST.map((c) => [c, f1(perEndpoint.define[c]), f1(perEndpoint.build[c])]), ["<b>Total</b>", `<b>${f1(sumPer("define"))}</b>`, `<b>${f1(sumPer("build"))}</b>`]]
)
const tblLoad = table(["Component", "ms", "share"], LOAD.map((c) => [c, f1(loadAvg[c] ?? 0), pct(loadAvg[c] ?? 0, S.med.moduleLoad)]))
const tblLevers = table(
  ["Lever", "Module load (1 ep)", "Saving", "Applies to"],
  [
    ["As shipped", f1(S.med.moduleLoad), "", ""],
    ["Minify (rolldown/Oxc)", f1(minLoad(0)), `−${f1(loadOf(0) - minLoad(0))} ms`, "any runtime"],
    ["Node compile cache (V8 code cache on disk)", f1(cacheLoad(0)), `−${f1(loadOf(0) - cacheLoad(0))} ms`, "Node (e.g. Lambda with a cache dir)"],
    ...(exp ? [["No <code>globalThis.FormData</code> at module scope", f1(exp.withoutFormData.eval - B), `−${f1(undiciMs)} ms`, "moves to the first <code>new Request()</code> on Node; a server also needs the <code>node:http</code> fix (§4)"]] : [])
  ]
)
const tblLeversAll = table(
  ["Endpoints", "As shipped", "Minified", "Compile cache", "Bundle KB", "Minified KB"],
  rows.map((r, i) => [r.endpoints, f1(loadOf(i)), f1(minLoad(i)), f1(cacheLoad(i)), f0(r.bundleKB), f0(minRows[i].bundleKB)])
)
const tblExperiment = exp && table(
  ["Variant", "Module load", "Define", "Build", "First request", "Total"],
  [["As shipped", exp.baseline], ["FormData ref removed", exp.withoutFormData]].map(([l, x]) => [l, f1(x.eval - B), f1(x.define), f1(x.handler), f1(x.first), f1(x.total)])
)
const tblBytes = table(["Category", ...charts.bundle.rows.map((r) => r.label)], BYTES.map((c) => [c, ...charts.bundle.rows.map((r) => f1(r.values[c] ?? 0))]))
const fnTable = (names) => table(["Function (source)", "ms (profiled)"], names.map(([n, ms]) => [`<code>${esc(n)}</code>`, f1(ms)]))
const topFns = (phases) => {
  const m = {}
  for (const ph of phases) for (const f of bigProfile.topFunctions[ph]) m[f.name] = (m[f.name] ?? 0) + f.ms
  return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 10)
}
const tblRaw = table(
  ["Endpoints", "eval", "define", "layer", "handler", "first", "second", "openapi", "CPU @1st resp", "heap MB"],
  raw.results.map((r) => [r.endpoints, ...["eval", "define", "layer", "handler", "first", "second", "openapi", "cpuColdStart", "heapUsedMB"].map((k) => `${f1(r.stats[k].median)} <span class="muted">/ ${f1(r.stats[k].p95)}</span>`)])
)

// ------------------------------------------------------------------ html
const env = data.env
const afterLoadL = L.med.afterLoad
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Effect HttpApi cold start</title>
<style>
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb;
  --ink: #0b0b0b; --ink-2: #52514e; --ink-3: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --ring: rgba(11,11,11,0.10);
  --neutral: #c3c2b7; --neutral-2: #898781;
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100;
  --s5: #e87ba4; --s6: #008300; --s7: #4a3aa7; --s8: #e34948;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19;
    --ink: #ffffff; --ink-2: #c3c2b7; --ink-3: #898781;
    --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,0.10);
    --neutral: #52514e; --neutral-2: #898781;
    --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500;
    --s5: #d55181; --s6: #008300; --s7: #9085e9; --s8: #e66767;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--background, var(--page)); color: var(--foreground, var(--ink)); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 960px; margin: 0 auto; padding: 32px 20px 64px; }
h1 { font-size: 28px; line-height: 1.2; margin: 0 0 6px; font-weight: 650; }
h2 { font-size: 20px; margin: 44px 0 6px; font-weight: 650; }
h3 { font-size: 15px; margin: 24px 0 6px; font-weight: 650; }
p { margin: 8px 0; color: var(--ink-2); }
p b, li b, td b { color: var(--ink); font-weight: 600; }
ul, ol { color: var(--ink-2); padding-left: 20px; }
li { margin: 6px 0; }
code { font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--ring); padding: 1px 4px; border-radius: 4px; color: var(--ink); }
.sub { color: var(--ink-3); font-size: 13px; }
.muted { color: var(--ink-3); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin: 24px 0 8px; }
.tile { background: var(--surface); border: 1px solid var(--ring); border-radius: 10px; padding: 16px; }
.tile .label { font-size: 13px; color: var(--ink-2); }
.tile .value { font-size: 30px; font-weight: 650; margin: 4px 0 2px; color: var(--ink); }
.tile .value small { font-size: 15px; font-weight: 500; color: var(--ink-2); }
.tile .note { font-size: 12.5px; color: var(--ink-3); }
.card { background: var(--surface); border: 1px solid var(--ring); border-radius: 10px; padding: 18px 18px 10px; margin: 14px 0; }
.card h4 { margin: 0 0 2px; font-size: 14px; font-weight: 600; color: var(--ink); }
.card .caption { font-size: 12.5px; color: var(--ink-3); margin: 0 0 10px; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12.5px; color: var(--ink-2); margin: 4px 0 8px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.chart svg { display: block; width: 100%; overflow: visible; }
.chart text { font-size: 11.5px; fill: var(--ink-3); font-variant-numeric: tabular-nums; }
.chart text.lbl { fill: var(--ink-2); font-size: 12px; }
.chart text.val { fill: var(--ink); font-size: 12px; font-weight: 600; }
details { margin: 6px 0 4px; }
summary { cursor: pointer; font-size: 12.5px; color: var(--ink-3); padding: 4px 0; }
table { border-collapse: collapse; width: 100%; font-size: 13px; margin: 8px 0 12px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--grid); }
th { font-weight: 600; color: var(--ink-2); font-size: 12px; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.callout { border-left: 3px solid var(--s1); background: var(--surface); padding: 10px 14px; border-radius: 0 8px 8px 0; margin: 14px 0; }
.callout p { margin: 4px 0; }
.tip { position: fixed; pointer-events: none; background: var(--surface); color: var(--ink); border: 1px solid var(--ring); box-shadow: 0 4px 16px rgba(0,0,0,.12); border-radius: 8px; padding: 8px 10px; font-size: 12.5px; line-height: 1.45; opacity: 0; transition: opacity .08s; z-index: 10; max-width: 300px; }
.tip .k { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; }
.tip .row { display: flex; justify-content: space-between; gap: 14px; }
.tip .row span:last-child { font-variant-numeric: tabular-nums; font-weight: 600; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
@media (max-width: 720px) { .cols { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main>
<h1>Effect HttpApi cold start</h1>
<p class="sub">effect ${esc(env.effect)} · node ${esc(env.node)} · ${esc(env.platform)} · ${esc(env.cpu)} (${env.cores} cores) · rolldown ${esc(env.rolldown)} · ${env.runs} fresh processes per size · ${esc(new Date(data.generatedAt).toUTCString())}</p>

<p><b>Cold start = start the server and answer one request.</b> Each sample launches a brand-new <code>node</code> process running a single rolldown bundle of an <code>effect/http-api</code> server (<code>HttpRouter.serve</code> on <code>@effect/platform-node</code>'s <code>NodeHttpServer</code>), waits until it is listening, sends one real HTTP <code>GET</code> over loopback and stops the clock when the response has been fully received. The clock starts just before <code>spawn()</code>, so it covers everything: process creation, Node boot, parsing, compiling and evaluating the bundle, defining the API, building the handler, binding the socket, and serving a request with code V8 has never run before. APIs have <b>${E.join(", ")}</b> endpoints.</p>

<div class="tiles">
  <div class="tile"><div class="label">Server cold start, ${SS.endpoints} endpoint</div><div class="value">${f0(SS.med.coldStart)} <small>ms</small></div><div class="note">spawn → HTTP response received · p95 ${f0(SS.p95.coldStart)} ms</div></div>
  <div class="tile"><div class="label">Server cold start, ${SL.endpoints} endpoints</div><div class="value">${f0(SL.med.coldStart)} <small>ms</small></div><div class="note">p95 ${f0(SL.p95.coldStart)} ms · ${f0(SL.med.cpu)} ms CPU across all threads</div></div>
  <div class="tile"><div class="label">Added per endpoint</div><div class="value">${f0(serverFits.coldStart.slope * 1000)} <small>µs</small></div><div class="note">linear (R² ${serverFits.coldStart.r2.toFixed(3)}); the same work costs ${f0(warmFits.warm.slope * 1000)} µs once code is hot</div></div>
  <div class="tile"><div class="label">Cold-code penalty</div><div class="value">${pct(penalty(WL), WL.med.cold)}</div><div class="note">of define + build + first request at ${WL.endpoints} endpoints (${pct(penalty(WS), WS.med.cold)} at ${WS.endpoints}) is V8 running code for the first time</div></div>
</div>

<div class="callout">
<p><b>Summary.</b> Starting a minimal HttpApi server and getting a response back takes <b>${f0(SS.med.coldStart)} ms</b>: ${f0(SS.med.spawn + SS.med.boot)} ms to spawn and boot Node, ${f0(SS.med.moduleLoad)} ms to load the bundle, ${f0(SS.med.define + SS.med.build)} ms to define the API, build the handler and listen, and ${f0(SS.med.request)} ms for the first request. Each endpoint adds <b>~${f0(serverFits.coldStart.slope * 1000)} µs</b>, so 500 endpoints take <b>${f0(SL.med.coldStart)} ms</b>. About ${f0(undiciSaving)} ms of every Node server cold start is Node initializing undici for web APIs the server never uses (§4). The biggest finding is that <b>most of the post-load time is not the work itself but running it cold</b>: rebuilding the same API in the same process once V8 has compiled and optimized the code takes ${f1(WS.med.warm)} ms instead of ${f1(WS.med.cold)} ms at ${WS.endpoints} endpoint and ${f0(WL.med.warm)} ms instead of ${f0(WL.med.cold)} ms at ${WL.endpoints}. Cold start is therefore driven as much by <i>how much distinct code runs at startup</i> as by how much work it does.</p>
</div>

<h2>1 · Anatomy of a cold start</h2>
<p>Every phase from <code>spawn()</code> to the HTTP response arriving back at the client, as medians and in execution order. <b>Spawn</b> is process creation plus the time for the "listening" line to reach the client (measured with an empty script: ${f1(rawServer.spawnBaseline)} ms to its first output line, which also includes Node boot). <b>Define API</b> is <code>HttpApi.make(…).add(…)</code> with all its schemas. <b>Build handler + listen</b> is <code>HttpApiBuilder</code> plus building the <code>HttpRouter.serve</code> layer on <code>NodeHttpServer</code> until the socket is bound. <b>First HTTP request</b> is the client's round trip for one <code>GET</code>, of which ${f1(SS.med.serverRequest)} ms is spent inside the server.</p>
<div class="card"><h4>Server cold start: spawn → first HTTP response</h4><p class="caption">median ms · hover for values</p><div class="chart" data-chart="serverAnatomy"></div>${details("Table view", tblServer)}</div>
<ul>
<li><b>Before any API code runs</b>, a server has already spent ${f0(SS.med.spawn + SS.med.boot + SS.med.moduleLoad)} ms on spawning, booting Node and loading the ${f0(SS.bundleKB)} KB bundle: ${pct(SS.med.spawn + SS.med.boot + SS.med.moduleLoad, SS.med.coldStart)} of a small server's cold start.</li>
<li><b>Define + build + listen</b> grow with the API: ${f0(SS.med.define + SS.med.build)} ms at ${SS.endpoints} endpoint, ${f0(SL.med.define + SL.med.build)} ms at ${SL.endpoints}.</li>
<li><b>The first HTTP request</b> takes ${f1(SS.med.request)}–${f1(SL.med.request)} ms. It is cold too: the server runs the request path (parsing, routing, decoding, encoding) for the first time.</li>
</ul>
<h3>Web-handler mode (Worker-style)</h3>
<p>The same app as a web handler (<code>HttpRouter.toWebHandler</code>, platform-neutral bundle, request passed in-process as a <code>Request</code>), which is how it would run on Cloudflare Workers or another fetch-based runtime. There is no spawn, socket or Node server stack, and the clock runs from process start to the response body. This mode is also what the CPU profiles and the cold/warm experiment below use.</p>
<div class="card"><h4>Web handler: process start → first response</h4><p class="caption">median ms · module load split by CPU-profile shares · hover for values</p><div class="chart" data-chart="anatomy"></div>${details("Table view", tblAnatomy)}</div>
<ul>
<li><b>Small APIs are dominated by fixed cost.</b> At ${S.endpoints} endpoint, ${pct(B + S.med.moduleLoad, S.med.cold)} of the cold start happens before any API code runs. Of the ${f0(S.med.moduleLoad)} ms module load, ~${f0(loadAvg["Parse & compile bundle"])} ms is parsing and compiling the ${f0(S.bundleKB)} KB bundle and ~${f0(loadAvg["Node: undici init"])} ms is Node initializing undici (Node-only, see §4).</li>
<li><b>In large APIs, define + build become the largest part:</b> ${pct(L.med.define + L.med.build, L.med.cold)} of the cold start at ${L.endpoints} endpoints, ahead of module load (${pct(L.med.moduleLoad, L.med.cold)}) and Node boot (${pct(B, L.med.cold)}).</li>
<li><b>The first request always pays ~${f0(L.med.first)} ms</b> regardless of size. A warm request takes ${f1(L.med.second)} ms, so this is almost entirely first-time code execution (see §2).</li>
<li><b>CPU exceeds wall time.</b> V8's concurrent compiler and GC threads add CPU on top of the main thread: ${f0(L.med.cpuCold)} ms CPU vs ${f0(L.med.cold)} ms wall at ${L.endpoints} endpoints. That matters wherever startup CPU is capped or billed.</li>
</ul>

<h2>2 · Cold code vs real work</h2>
<p>To separate the cost of running code <i>for the first time</i> from the work itself, each process runs the cold pass and then rebuilds everything from scratch five more times in the same process: a new API definition, layer, handler and request each time. We report the last rebuild. The work is identical, but V8 has by then lazily compiled the functions, tiered them up from the interpreter and warmed inline caches, and any one-time lazy initialization has happened. <b>Cold − warm is the cold-code penalty</b>, a cost that exists only because it is a cold start.</p>
<div class="card"><h4>Define + build + first request: work vs cold-code penalty</h4><p class="caption">median ms, same process · hover for values</p><div class="chart" data-chart="coldWarm"></div>${details("Table view", tblColdWarm)}</div>
<ul>
<li><b>At ${WS.endpoints} endpoint, ${pct(penalty(WS), WS.med.cold)} is penalty</b>: the work takes ${f1(WS.med.warm)} ms hot but ${f1(WS.med.cold)} ms cold. The first request alone is ${x1(WS.med.coldFirst, WS.med.warmFirst)} slower cold (${f1(WS.med.coldFirst)} vs ${f1(WS.med.warmFirst)} ms), and the handler build ${x1(WS.med.coldBuild, WS.med.warmBuild)}.</li>
<li><b>The penalty grows with API size too</b> (${f0(penalty(WL))} ms at ${WL.endpoints} endpoints) but its share shrinks to ${pct(penalty(WL), WL.med.cold)}: later endpoints reuse code paths the first ones already warmed. That is why the per-endpoint cost is higher for small APIs (${f0(marginalRaw[0])} µs/ep from 1→10) and settles at ~${f0(marginalRaw.at(-1))} µs/ep.</li>
<li><b>Implication.</b> Algorithmic tuning of define/build only addresses the warm ${f0(warmFits.warm.slope * 1000)} µs/ep. Cutting the amount of <i>distinct</i> code executed at startup (fewer layers of indirection, fewer generic combinators on the build path, deferring per-route setup until a route is first hit) is what moves cold start.</li>
</ul>
<div class="card"><h4>Cold vs warm as the API grows</h4><p class="caption">define + build + first request, median ms · hover for values</p><div class="chart" data-chart="coldWarmLines"></div></div>

<h2>3 · How cold start grows with API size</h2>
<p>Cold start grows <b>linearly</b>: ~${f0(fits.cold.slope * 1000)} µs per endpoint on top of ~${f0(fits.cold.intercept)} ms fixed (R² ${fits.cold.r2.toFixed(3)}). Define and build share the per-endpoint cost about evenly. Module load grows only with bundle size (+${f1(fits.bundleKB.slope)} KB, +${f1(fits.moduleLoad.slope * 1000)} µs per endpoint), and the first request is flat.</p>
<div class="card"><h4>Cold-start phases vs endpoint count</h4><p class="caption">median ms · linear x axis · hover for values</p><div class="chart" data-chart="growth"></div>${details("Table view", tblGrowth)}</div>
<div class="cols">
<div><h3>Linear fit</h3>${tblFits}</div>
<div><h3>Marginal cost (define + build + first)</h3><p>µs per added endpoint between consecutive sizes. It is high for the first endpoints, while everything is still cold, then flat.</p>${table(["Step", "µs / endpoint"], marginal)}</div>
</div>

<h3>What the per-endpoint cold cost is spent on</h3>
<p>CPU profiles (${env.profileRuns} per size) are split into phases using monotonic timestamps from the harness, and samples are attributed to Effect source files via sourcemaps. Category times are profile shares scaled to the un-profiled medians, and the per-endpoint figure is each category's linear-fit slope.</p>
<div class="card"><h4>Cold per-endpoint cost by category</h4><p class="caption">µs per added endpoint · hover for values</p><div class="chart" data-chart="perEndpoint"></div>${details("Table view", tblPerEndpoint)}</div>
<ul>
<li><b>Define (${f0(sumPer("define"))} µs/ep):</b> mostly <b>Schema</b> construction (${f0(perEndpoint.define.Schema)} µs: <code>schema/make.ts</code>, <code>SchemaAST.struct</code>), then HttpApi bookkeeping (${f0(perEndpoint.define["HttpApi definition"])} µs, including <code>validateResponseExclusivity</code> on every endpoint) and <code>pipe</code>/<code>dual</code> (${f0(perEndpoint.define["pipe / dual / predicates"])} µs).</li>
<li><b>Build (${f0(sumPer("build"))} µs/ep):</b> the <b>router</b> is the largest single part (${f0(perEndpoint.build["Router (FindMyWay)"])} µs: <code>FindMyWay._on</code> does string slicing, <code>toLowerCase</code> and <code>split/join</code> per segment), then per-route setup in <b>HttpApiBuilder</b> (${f0(perEndpoint.build.HttpApiBuilder)} µs: <code>handlerToRoute</code>, encoders, decoders), the <b>Effect runtime</b> running the layer (${f0(perEndpoint.build["Effect runtime & Layer"])} µs) and <b>Schema</b> codec derivation (${f0(perEndpoint.build.Schema)} µs).</li>
<li><b>GC</b> adds ${f0(perEndpoint.define["Garbage collector"] + perEndpoint.build["Garbage collector"])} µs/ep: startup allocates many short-lived AST and closure objects.</li>
</ul>
<div class="cols">
<div class="card"><h4>Build handler, by size</h4><p class="caption">ms (scaled)</p><div class="chart" data-chart="buildMix"></div>${details("Table view", catTable("build"))}</div>
<div class="card"><h4>Define API, by size</h4><p class="caption">ms (scaled)</p><div class="chart" data-chart="defineMix"></div>${details("Table view", catTable("define"))}</div>
</div>
<div class="cols">
<div>${details(`Define: hottest functions at ${L.endpoints} endpoints`, fnTable(topFns(["define"])))}</div>
<div>${details(`Build: hottest functions at ${L.endpoints} endpoints`, fnTable(topFns(["layer", "handler"])))}</div>
</div>

<h2>4 · Module load: the fixed part</h2>
<p>Module load takes ~${f0(S.med.moduleLoad)} ms at every size, before a single line of API code runs.</p>
<div class="card"><h4>Inside module load</h4><p class="caption">ms, profile shares scaled to the measured median, averaged over sizes</p><div class="chart" data-chart="load"></div>${details("Table view", tblLoad)}</div>
<ul>
<li><b>Parse & compile (~${pct(loadAvg["Parse & compile bundle"], S.med.moduleLoad)})</b> scales with bundle size. HttpApi pulls in Schema, the HTTP server stack (request/response, cookies, multipart), streams and the router whatever the API uses, so the floor is ${f0(S.bundleKB)} KB unminified.</li>
<li><b>undici init (~${pct(loadAvg["Node: undici init"], S.med.moduleLoad)}, Node only).</b> Node creates its fetch-related globals lazily, and the first touch loads undici and its dependencies (crypto, zlib, web streams). workerd has these natively. See below for what triggers it.</li>
<li><b>Effect's own module evaluation</b> (services, tags, schema singletons) is ~${f0(loadAvg["Effect module evaluation"])} ms.</li>
</ul>
<h3>Measured levers</h3>
<div class="card"><h4>Module load under each lever (web-handler bundle)</h4><p class="caption">median ms · each lever measured on its own · ${S.endpoints}-endpoint app, except the FormData A/B (${exp?.size ?? ""} app; module load barely depends on size)</p><div class="chart" data-chart="levers"></div>${details("Table view", tblLevers)}${details("All sizes", tblLeversAll)}</div>
<ul>
<li><b>Minify:</b> −${f0(minSaving)} ms on average (${f0(S.bundleKB)} → ${f0(minRows[0].bundleKB)} KB). Works on any runtime.</li>
<li><b>Node compile cache</b> (<code>NODE_COMPILE_CACHE</code>, V8 code cache on disk): −${f0(cacheSaving)} ms of module load. It leaves define/build unchanged, because the cache holds the code compiled at load time, while the functions that only run later during define and build are still compiled lazily on first call.</li>
</ul>
${expU ? `<h3>Why every Node server pays for undici</h3>
<p>Two independent things load undici during startup, each costing about 30 ms in isolation (Node ${esc(expU.node)}):</p>
<ol>
<li><b><code>Schema.ts</code> evaluates <code>instanceOf(globalThis.FormData)</code> at module scope.</b> Touching <code>FormData</code> in an empty process costs ${f1(expU.isolated.touchFormDataMs)} ms.</li>
<li><b>An ESM <code>import … from "node:http"</code></b>, which <code>@effect/platform-node</code> does. Node 24's <code>http</code> module exposes lazy, undici-backed <code>WebSocket</code>, <code>CloseEvent</code> and <code>MessageEvent</code> getters, and an ESM import snapshots every export, which triggers them: <code>import("node:http")</code> costs ${f1(expU.isolated.esmImportNodeHttpMs)} ms, while <code>process.getBuiltinModule("node:http")</code> (or <code>require</code>) costs ${f1(expU.isolated.getBuiltinModuleNodeHttpMs)} ms.</li>
</ol>
<div class="card"><h4>Server cold start with the undici triggers removed</h4><p class="caption">${expU.size} API, median of ${expU.runs} runs · each variant patches the bundle</p><div class="chart" data-chart="undici"></div>${details("Table view", tblUndici)}</div>
<p>Removing either trigger alone changes nothing, because the other one still loads undici. <b>Removing both cuts server cold start by ${f0(undiciSaving)} ms</b> (${f1(expU.server["As shipped"].coldStart)} → ${f1(expU.server["Both removed"].coldStart)} ms), and undici is never loaded. In <b>web-handler mode</b> the FormData reference is the only trigger: removing it drops module load from ${f0(exp.baseline.eval - B)} to ${f0(exp.withoutFormData.eval - B)} ms, but the cost reappears in the first <code>new Request()</code> (${f1(exp.baseline.first)} → ${f1(exp.withoutFormData.first)} ms), so on Node the total doesn't change; on workerd these globals are native and the cost doesn't exist.</p>
${details("A/B detail: web-handler mode", tblExperiment)}` : ""}
<div class="card"><h4>What is in the bundle</h4><p class="caption">KB of output per source category (unminified)</p><div class="chart" data-chart="bundle"></div>${details("Table view", tblBytes)}</div>

<h2>5 · Where to cut cold start</h2>
<ol>
<li><b>Defer per-route setup to the first hit on that route.</b> Build is ${f0(sumPer("build"))} µs/endpoint and is paid upfront for every route. Compiling a route's codecs and handler pipeline (<code>handlerToRoute</code>, <code>SchemaAST.copy</code>/<code>make</code>) on first request would make cold start pay only for the routes a fresh instance actually serves.</li>
<li><b>Execute less distinct code at startup.</b> ${pct(penalty(WS), WS.med.cold)} (small) to ${pct(penalty(WL), WL.med.cold)} (large) of post-load time is cold-code penalty. Fewer generic layers on the define/build path (<code>dual</code>/<code>pipe</code> wrappers, Effect-runtime-driven layer construction for what is synchronous setup) cut both the work and the code that has to be compiled.</li>
<li><b>Cheaper route registration.</b> <code>FindMyWay._on</code> is the top self-time function in build. Its per-segment <code>split/join</code> and <code>toLowerCase</code> could be skipped for plain segments, or the tree could be built lazily on first lookup.</li>
<li><b>Stop loading undici in Node servers (−${f0(undiciSaving)} ms per cold start, measured).</b> Two changes are needed together: make the <code>FormData</code>/<code>File</code> guards in <code>Schema.ts</code> read the global lazily inside the check, and have <code>@effect/platform-node</code> obtain <code>node:http</code> through <code>process.getBuiltinModule("node:http")</code> (Node ≥ 20.16 / 22.3) instead of a static ESM import.</li>
<li><b>For users:</b> minify (−${f0(minSaving)} ms), enable the compile cache where the platform allows (−${f0(cacheSaving)} ms on Node), and reuse schema values across endpoints.</li>
</ol>

<h2>Methodology</h2>
<ul>
<li><b>Server mode (headline).</b> Harness + generated API + <code>@effect/platform-node</code> bundled by rolldown (<code>platform: "node"</code>). The runner, a long-lived Node process, records the time, spawns the server, waits for its "listening" line (port 0 on 127.0.0.1), sends <code>GET /r0/1</code> (<code>/r0</code> for 1-endpoint groups) with a fresh connection, and stops the clock when the response body has been read. The server reports its own phase times and its CPU when the response is sent.</li>
<li><b>Web-handler mode.</b> Harness + generated API bundled by rolldown into one ESM file (<code>platform: "neutral"</code>, JSDoc stripped, unminified unless stated). <code>effect</code> resolves from the published npm package exactly like an app. Each sample is a new <code>node</code> process: two discarded warmup processes per size (to warm the OS file cache only; every measured process is a cold V8 isolate), then ${env.runs} measured, run sequentially. Node's compile cache is off except in the lever experiment.</li>
<li><b>Cold start</b> = time from process start (<code>performance.timeOrigin</code>) until the first response body has been read. Node boot is the median time-to-first-line of an empty script (${f1(B)} ms). CPU is <code>process.cpuUsage()</code> at the first response (all threads).</li>
<li><b>API shape.</b> <code>G</code> groups × <code>E</code> endpoints (${data.sizes.map((s) => `${s.groups}×${s.endpoints}`).join(", ")}). Each group is a REST resource with an entity struct (int, strings, literal union, optional, array, nested struct), create/update payloads, a <code>TaggedError</code> 404, a struct 409, and list/get/create/update/delete endpoints plus <code>actionN</code> endpoints with their own schemas. Handlers are trivial.</li>
<li><b>Cold vs warm.</b> In-process rebuilds with <code>BENCH_WARM=5</code>, last iteration reported, ${rawWarm.runs} processes per size.</li>
<li><b>Attribution.</b> <code>--cpu-prof</code> at ${env.profileIntervalUs} µs, ${env.profileRuns} profiles per size. Samples are assigned to phases with <code>process.hrtime</code> marks (the profiler's own monotonic clock) and to sources through sourcemaps chained into Effect's <code>.ts</code> files. Before the harness runs, samples are classified as bundle compile (under <code>compileSourceTextModule</code>), module code (bundle frame on the stack) or Node boot. <code>node:</code> frames under an undici frame count as undici init.</li>
<li><b>Caveats.</b> Node is not workerd. V8 is the same, so the scaling, the cold-code penalty and the hot spots carry over, but absolute times, Node boot and the undici cost do not.</li>
</ul>

<h2>Appendix</h2>
<p><b>Not part of cold start: OpenAPI generation.</b> <code>OpenApi.fromApi</code> costs ${f0(fits.openapi.slope * 1000)} µs/endpoint (${f0(L.med.openapi)} ms at ${L.endpoints} endpoints), but <code>HttpApiScalar</code>, <code>HttpApiSwagger</code> and <code>openapiPath</code> all build it lazily and memoize it, so only the first <code>/docs</code> request on an instance pays it.</p>
${details("Raw medians / p95 (ms) for every phase", tblRaw)}
<p class="sub">Reproduce: <code>node scripts/collect.mjs &amp;&amp; node scripts/experiment-undici.mjs &amp;&amp; node scripts/render-report.mjs</code> · source: <a href="https://github.com/mikearnaldi/benchmark-http-api-boot" style="color:inherit">github.com/mikearnaldi/benchmark-http-api-boot</a></p>
</main>
<div class="tip" id="tip"></div>
<script>
const CHARTS = ${JSON.stringify(charts)};
const tip = document.getElementById("tip");
const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};
const fmt = (v, unit) => (unit === "KB" || unit === "µs" ? Math.round(v).toLocaleString("en-US") : v >= 100 ? Math.round(v).toString() : v.toFixed(1)) + " " + unit;
const showTip = (ev, html) => {
  tip.innerHTML = html;
  tip.style.opacity = 1;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = ev.clientX + 14, y = ev.clientY + 14;
  if (x + w > innerWidth - 8) x = ev.clientX - w - 14;
  if (y + h > innerHeight - 8) y = ev.clientY - h - 14;
  tip.style.left = x + "px"; tip.style.top = y + "px";
};
const hideTip = () => { tip.style.opacity = 0; };
const nice = (max) => {
  const raw = max / 4, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  return { step, max: Math.ceil(max / step) * step };
};
const legend = (mount, series) => {
  const l = document.createElement("div");
  l.className = "legend";
  l.innerHTML = series.map((s) => '<span><i style="background:' + s.color + '"></i>' + s.label + "</span>").join("");
  mount.appendChild(l);
};

function stack(mount, c) {
  const series = c.series.filter((s) => c.rows.some((r) => (r.values[s.key] ?? 0) > 0));
  if (series.length > 1) legend(mount, series);
  const W = mount.clientWidth, labelW = Math.min(240, Math.max(...c.rows.map((r) => r.label.length)) * 7 + 14), right = 64;
  const barH = 22, gap = 16, top = 4, axisH = 22;
  const H = top + c.rows.length * (barH + gap) - gap + axisH + 6;
  const svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, height: H });
  const totals = c.rows.map((r) => series.reduce((n, s) => n + Math.max(0, r.values[s.key] ?? 0), 0));
  const { step, max } = nice(Math.max(...totals));
  const plotW = W - labelW - right, x = (v) => labelW + (v / max) * plotW;
  const yAxis = top + c.rows.length * (barH + gap) - gap + 4;
  for (let t = 0; t <= max + 1e-9; t += step) {
    svgEl("line", { x1: x(t), x2: x(t), y1: top - 2, y2: yAxis, stroke: "var(--grid)", "stroke-width": 1 }, svg);
    svgEl("text", { x: x(t), y: yAxis + 14, "text-anchor": "middle" }, svg).textContent = Math.round(t).toLocaleString("en-US") + " " + c.unit;
  }
  c.rows.forEach((r, i) => {
    const y = top + i * (barH + gap);
    svgEl("text", { x: labelW - 10, y: y + barH / 2 + 4, "text-anchor": "end", class: "lbl" }, svg).textContent = r.label;
    let acc = 0;
    const segs = series.map((s) => ({ s, v: Math.max(0, r.values[s.key] ?? 0) })).filter((d) => d.v > 0);
    segs.forEach((d, j) => {
      const x0 = x(acc), x1 = x(acc + d.v);
      acc += d.v;
      const last = j === segs.length - 1;
      const w = Math.max(0.5, x1 - x0 - (last ? 0 : 2));
      const rad = last ? Math.min(4, w / 2) : 0;
      const p = "M" + x0 + "," + y + "h" + (w - rad) + (rad ? "a" + rad + "," + rad + " 0 0 1 " + rad + "," + rad : "") + "v" + (barH - 2 * rad) + (rad ? "a" + rad + "," + rad + " 0 0 1 " + -rad + "," + rad : "") + "h" + -(w - rad) + "z";
      const path = svgEl("path", { d: p, fill: d.s.color }, svg);
      const hit = svgEl("rect", { x: x0, y: y - 4, width: Math.max(6, x1 - x0), height: barH + 8, fill: "transparent" }, svg);
      const html = "<b>" + r.label + "</b><div class='row'><span><i class='k' style='background:" + d.s.color + "'></i>" + d.s.label + "</span><span>" + fmt(d.v, c.unit) + "</span></div><div class='row'><span>share of bar</span><span>" + Math.round((d.v / totals[i]) * 100) + "%</span></div>";
      hit.addEventListener("mousemove", (ev) => { path.setAttribute("opacity", 0.8); showTip(ev, html); });
      hit.addEventListener("mouseleave", () => { path.setAttribute("opacity", 1); hideTip(); });
    });
    svgEl("text", { x: x(totals[i]) + 8, y: y + barH / 2 + 4, class: "val" }, svg).textContent = fmt(totals[i], c.unit);
  });
  mount.appendChild(svg);
}

function line(mount, c) {
  legend(mount, c.series);
  const W = mount.clientWidth, H = 280, left = 52, right = 170, top = 10, bottom = 34;
  const svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, height: H });
  const xmax = Math.max(...c.x), { step, max } = nice(Math.max(...c.series.flatMap((s) => s.values)));
  const X = (v) => left + (v / xmax) * (W - left - right), Y = (v) => top + (1 - v / max) * (H - top - bottom);
  for (let t = 0; t <= max + 1e-9; t += step) {
    svgEl("line", { x1: left, x2: W - right, y1: Y(t), y2: Y(t), stroke: t === 0 ? "var(--axis)" : "var(--grid)", "stroke-width": 1 }, svg);
    svgEl("text", { x: left - 8, y: Y(t) + 4, "text-anchor": "end" }, svg).textContent = Math.round(t) + (t === max ? " " + c.unit : "");
  }
  const xt = nice(xmax);
  for (let t = 0; t <= xmax + 1e-9; t += xt.step) svgEl("text", { x: X(t), y: H - bottom + 18, "text-anchor": "middle" }, svg).textContent = t;
  svgEl("text", { x: W - right, y: H - 2, "text-anchor": "end" }, svg).textContent = c.xLabel + " →";
  const ends = [];
  for (const s of c.series) {
    const d = s.values.map((v, i) => (i ? "L" : "M") + X(c.x[i]) + "," + Y(v)).join("");
    svgEl("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
    s.values.forEach((v, i) => svgEl("circle", { cx: X(c.x[i]), cy: Y(v), r: 4, fill: s.color, stroke: "var(--surface)", "stroke-width": 2 }, svg));
    ends.push({ s, y: Y(s.values.at(-1)), v: s.values.at(-1) });
  }
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
  for (const e of ends) {
    svgEl("text", { x: X(xmax) + 10, y: e.y + 4, class: "lbl" }, svg).textContent = e.s.label.replace(/ \\(.*\\)$/, "") + " " + (e.v >= 100 ? Math.round(e.v) : e.v.toFixed(1));
  }
  const cross = svgEl("line", { y1: top, y2: H - bottom, stroke: "var(--axis)", "stroke-width": 1, opacity: 0 }, svg);
  const hit = svgEl("rect", { x: left, y: top, width: W - left - right, height: H - top - bottom, fill: "transparent" }, svg);
  hit.addEventListener("mousemove", (ev) => {
    const pt = svg.getBoundingClientRect(), mx = ((ev.clientX - pt.left) / pt.width) * W;
    let best = 0;
    c.x.forEach((v, i) => { if (Math.abs(X(v) - mx) < Math.abs(X(c.x[best]) - mx)) best = i; });
    cross.setAttribute("x1", X(c.x[best])); cross.setAttribute("x2", X(c.x[best])); cross.setAttribute("opacity", 1);
    const rows = [...c.series].sort((a, b) => b.values[best] - a.values[best]).map((s) => "<div class='row'><span><i class='k' style='background:" + s.color + "'></i>" + s.label + "</span><span>" + fmt(s.values[best], c.unit) + "</span></div>").join("");
    showTip(ev, "<b>" + c.x[best] + " " + c.xLabel + "</b>" + rows);
  });
  hit.addEventListener("mouseleave", () => { cross.setAttribute("opacity", 0); hideTip(); });
  mount.appendChild(svg);
}

const renderAll = () => {
  for (const mount of document.querySelectorAll("[data-chart]")) {
    const c = CHARTS[mount.dataset.chart];
    mount.innerHTML = "";
    if (!c) continue;
    (c.type === "line" ? line : stack)(mount, c);
  }
};
renderAll();
let rt;
addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(renderAll, 120); });
</script>
</body>
</html>
`
writeFileSync(join(root, "reports", "report.html"), html)
console.log(`wrote ${join(root, "reports", "report.html")} (${(html.length / 1024).toFixed(0)} KB)`)
