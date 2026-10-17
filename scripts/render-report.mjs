// Renders reports/report.html from reports/data.json (+ bench samples and the
// FormData experiment). Self-contained: inline CSS/JS/SVG, no network.
//
//   node scripts/render-report.mjs
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (f) => JSON.parse(readFileSync(join(root, "reports", f), "utf8"))
const data = read("data.json")
const raw = read("bench-normal.json")
const exp = existsSync(join(root, "reports", "experiment-formdata.json")) ? read("experiment-formdata.json") : null

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

const B = raw.nodeBaseline
const derive = (s) => ({
  bootstrap: B,
  moduleLoad: s.eval - B,
  define: s.define,
  build: s.layer + s.handler,
  first: s.first,
  openapi: s.openapi,
  ready: s.eval + s.define + s.layer + s.handler + s.first,
  init: s.define + s.layer + s.handler + s.first,
  heap: s.heapUsedMB,
  cpuTotal: s.cpuTotal,
  second: s.second
})
const rows = raw.results.map((r) => {
  const ds = r.samples.map(derive)
  const keys = Object.keys(ds[0])
  const med = Object.fromEntries(keys.map((k) => [k, quantile(ds.map((d) => d[k]), 0.5)]))
  const p95 = Object.fromEntries(keys.map((k) => [k, quantile(ds.map((d) => d[k]), 0.95)]))
  return { size: r.size, endpoints: r.endpoints, bundleKB: r.bundleKB, med, p95 }
})
const minRows = data.timingsMin.results
const E = rows.map((r) => r.endpoints)
const fits = Object.fromEntries(["moduleLoad", "define", "build", "first", "openapi", "init", "ready", "heap", "bundleKB"].map((k) => [
  k, fit(E, rows.map((r) => (k === "bundleKB" ? r.bundleKB : r.med[k])))
]))
const largest = rows.at(-1)
const smallest = rows[0]

// ------------------------------------------------------------------ attribution
const POST = ["Router (FindMyWay)", "HttpApiBuilder", "HttpApi definition", "Schema", "Effect runtime & Layer", "pipe / dual / predicates", "Garbage collector", "Other"]
const foldPost = (cat) => (POST.includes(cat) ? cat : "Other")
const EVAL = ["Node: undici init", "Parse & compile bundle", "Effect module top-level code", "Garbage collector", "Other Node / V8"]
const foldEval = (cat) => {
  if (cat === "Node: undici init" || cat === "Parse & compile bundle" || cat === "Garbage collector") return cat
  if (cat === "Node built-ins" || cat === "V8 (program)") return "Other Node / V8"
  return "Effect module top-level code"
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
    size: p.size,
    endpoints: r.endpoints,
    eval: scale(fold(c.eval, foldEval), r.med.moduleLoad),
    evalRaw: fold(c.eval, foldEval),
    define: scale(fold(c.define, foldPost), r.med.define),
    build: scale(add(fold(c.layer, foldPost), fold(c.handler, foldPost)), r.med.build),
    first: scale(fold(c.first, foldPost), r.med.first),
    openapi: scale(fold(c.openapi, foldPost), r.med.openapi)
  }
})
const perEndpoint = Object.fromEntries(["define", "build", "openapi"].map((phase) => [
  phase,
  Object.fromEntries(POST.map((cat) => [cat, fit(E, attribution.map((a) => a[phase][cat] ?? 0)).slope * 1000]))
]))
const evalAvg = (() => {
  const out = {}
  for (const a of attribution) for (const [k, v] of Object.entries(a.eval)) out[k] = (out[k] ?? 0) + v / attribution.length
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
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
const table = (head, body, opts = {}) => `<table${opts.cls ? ` class="${opts.cls}"` : ""}><thead><tr>${head.map((h, i) => `<th${i ? ' class="num"' : ""}>${h}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ""}>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`
const details = (title, inner) => `<details><summary>${title}</summary>${inner}</details>`

const r500 = largest.med
const evalShare = evalAvg["Node: undici init"] / smallest.med.moduleLoad
const routerShare500 = attribution.at(-1).build["Router (FindMyWay)"] / largest.med.build
const routerShare1 = attribution[0].build["Router (FindMyWay)"] / smallest.med.build
const sumPer = (phase) => Object.values(perEndpoint[phase]).reduce((a, b) => a + b, 0)
const topCat = (phase) => Object.entries(perEndpoint[phase]).sort((a, b) => b[1] - a[1])
const undiciMs = exp ? exp.baseline.eval - exp.withoutFormData.eval : evalAvg["Node: undici init"]
const effectOwnLoad = exp ? exp.withoutFormData.eval - B : smallest.med.moduleLoad - evalAvg["Node: undici init"]
const minLoad = minRows[0].stats.eval.median - data.timingsMin.nodeBaseline

// ------------------------------------------------------------------ chart payload
const PHASE_SERIES = [
  { key: "bootstrap", label: "Node bootstrap", color: "var(--neutral)" },
  { key: "moduleLoad", label: "Module load", color: "var(--s1)" },
  { key: "define", label: "Define API", color: "var(--s2)" },
  { key: "build", label: "Build handler", color: "var(--s3)" },
  { key: "first", label: "First request", color: "var(--s4)" }
]
const CAT_SERIES = POST.map((k, i) => ({ key: k, label: k, color: `var(--s${i + 1})` }))
const EVAL_SERIES = EVAL.map((k, i) => ({ key: k, label: k, color: `var(--s${i + 1})` }))
const BYTE_SERIES = BYTES.map((k, i) => ({ key: k, label: k, color: `var(--s${i + 1})` }))

const charts = {
  waterfall: {
    type: "stack", unit: "ms", series: PHASE_SERIES,
    rows: rows.map((r) => ({ label: `${r.endpoints} endpoint${r.endpoints === 1 ? "" : "s"}`, values: Object.fromEntries(PHASE_SERIES.map((s) => [s.key, r.med[s.key]])) }))
  },
  growth: {
    type: "line", unit: "ms", x: E, xLabel: "endpoints",
    series: [
      { key: "openapi", label: "OpenAPI spec (on demand)", color: "var(--s5)", values: rows.map((r) => r.med.openapi) },
      { key: "moduleLoad", label: "Module load", color: "var(--s1)", values: rows.map((r) => r.med.moduleLoad) },
      { key: "build", label: "Build handler", color: "var(--s3)", values: rows.map((r) => r.med.build) },
      { key: "define", label: "Define API", color: "var(--s2)", values: rows.map((r) => r.med.define) },
      { key: "first", label: "First request", color: "var(--s4)", values: rows.map((r) => r.med.first) }
    ]
  },
  perEndpoint: {
    type: "stack", unit: "µs", series: CAT_SERIES,
    rows: [
      { label: "Define API", values: perEndpoint.define },
      { label: "Build handler", values: perEndpoint.build },
      { label: "OpenAPI spec", values: perEndpoint.openapi }
    ]
  },
  buildMix: {
    type: "stack", unit: "ms", series: CAT_SERIES,
    rows: attribution.map((a) => ({ label: `${a.endpoints} ep`, values: a.build }))
  },
  defineMix: {
    type: "stack", unit: "ms", series: CAT_SERIES,
    rows: attribution.map((a) => ({ label: `${a.endpoints} ep`, values: a.define }))
  },
  evalMix: {
    type: "stack", unit: "ms", series: EVAL_SERIES,
    rows: [{ label: "Module load", values: evalAvg }]
  },
  experiment: exp && {
    type: "stack", unit: "ms", series: PHASE_SERIES,
    rows: [
      { label: "As shipped", values: { bootstrap: B, moduleLoad: exp.baseline.eval - B, define: exp.baseline.define, build: exp.baseline.handler, first: exp.baseline.first } },
      { label: "FormData ref removed", values: { bootstrap: B, moduleLoad: exp.withoutFormData.eval - B, define: exp.withoutFormData.define, build: exp.withoutFormData.handler, first: exp.withoutFormData.first } }
    ]
  },
  bundle: {
    type: "stack", unit: "KB", series: BYTE_SERIES,
    rows: [rows[0], rows.at(-1)].map((r) => ({ label: `${r.endpoints} ep`, values: bytesFor(r.size) }))
  }
}

// ------------------------------------------------------------------ tables
const tblWaterfall = table(
  ["Endpoints", "Node bootstrap", "Module load", "Define API", "Build handler", "First request", "Ready (p50)", "Ready (p95)"],
  rows.map((r) => [r.endpoints, f1(r.med.bootstrap), f1(r.med.moduleLoad), f1(r.med.define), f1(r.med.build), f1(r.med.first), `<b>${f1(r.med.ready)}</b>`, f1(r.p95.ready)])
)
const tblGrowth = table(
  ["Endpoints", "Module load", "Define API", "Build handler", "First request", "OpenAPI spec", "2nd request"],
  rows.map((r) => [r.endpoints, f1(r.med.moduleLoad), f1(r.med.define), f1(r.med.build), f1(r.med.first), f1(r.med.openapi), f1(r.med.second)])
)
const fitRow = (label, k, unit = "µs") => [label, `${f1(fits[k].slope * (unit === "µs" ? 1000 : 1))} ${unit}`, `${f1(fits[k].intercept)} ${k === "bundleKB" ? "KB" : k === "heap" ? "MB" : "ms"}`, fits[k].r2.toFixed(4)]
const tblFits = table(
  ["Phase", "Cost per endpoint", "Fixed cost (intercept)", "R² (linear fit)"],
  [
    fitRow("Define API", "define"),
    fitRow("Build handler", "build"),
    fitRow("First request", "first"),
    fitRow("Module load", "moduleLoad"),
    fitRow("<b>Init → first response</b>", "init"),
    fitRow("OpenAPI spec (on demand)", "openapi"),
    fitRow("Heap used", "heap", "KB"),
    fitRow("Bundle size (unminified)", "bundleKB", "KB")
  ].map((r) => r[0] === "Heap used" ? [r[0], `${f1(fits.heap.slope * 1024)} KB`, `${f1(fits.heap.intercept)} MB`, r[3]] : r[0] === "Bundle size (unminified)" ? [r[0], `${f1(fits.bundleKB.slope)} KB`, `${f1(fits.bundleKB.intercept)} KB`, r[3]] : r)
)
const marginal = rows.slice(1).map((r, i) => {
  const a = rows[i]
  const per = (k) => ((r.med[k] - a.med[k]) / (r.endpoints - a.endpoints)) * 1000
  return [`${a.endpoints} → ${r.endpoints}`, f0(per("define")), f0(per("build")), f0(per("define") + per("build")), f0(per("openapi"))]
})
const marginalRaw = rows.slice(1).map((r, i) => ((r.med.define + r.med.build - rows[i].med.define - rows[i].med.build) / (r.endpoints - rows[i].endpoints)) * 1000)
const tblMarginal = table(["Step", "Define µs/ep", "Build µs/ep", "Define + build µs/ep", "OpenAPI µs/ep"], marginal)
const catTable = (phase) => table(
  ["Category", ...attribution.map((a) => `${a.endpoints} ep`), "µs / endpoint"],
  POST.map((c) => [c, ...attribution.map((a) => f1(a[phase][c] ?? 0)), f1(perEndpoint[phase][c])])
)
const tblPerEndpoint = table(
  ["Category", "Define API", "Build handler", "OpenAPI spec"],
  [...POST.map((c) => [c, f1(perEndpoint.define[c]), f1(perEndpoint.build[c]), f1(perEndpoint.openapi[c])]),
    ["<b>Total</b>", `<b>${f1(sumPer("define"))}</b>`, `<b>${f1(sumPer("build"))}</b>`, `<b>${f1(sumPer("openapi"))}</b>`]]
)
const tblEval = table(
  ["Component", "ms (scaled)", "share", "ms (raw profile)"],
  EVAL.map((c) => [c, f1(evalAvg[c] ?? 0), pct(evalAvg[c] ?? 0, smallest.med.moduleLoad), f1(attribution.reduce((n, a) => n + (a.evalRaw[c] ?? 0), 0) / attribution.length)])
)
const tblExperiment = exp && table(
  ["Variant", "Module load", "Define", "Build", "First request", "Total"],
  [["As shipped", exp.baseline, exp], ["FormData ref removed", exp.withoutFormData, exp]].map(([l, x]) => [l, f1(x.eval - B), f1(x.define), f1(x.handler), f1(x.first), f1(x.total)])
)
const tblBundle = table(
  ["Endpoints", "Unminified KB", "Minified KB", "Module load (unmin)", "Module load (min)"],
  rows.map((r, i) => [r.endpoints, f0(r.bundleKB), f0(minRows[i].bundleKB), f1(r.med.moduleLoad), f1(minRows[i].stats.eval.median - data.timingsMin.nodeBaseline)])
)
const tblBytes = table(
  ["Category", ...charts.bundle.rows.map((r) => r.label)],
  BYTES.map((c) => [c, ...charts.bundle.rows.map((r) => f1(r.values[c] ?? 0))])
)
const fnTable = (phase, n = 10) => table(["Function (source)", "ms (profiled, 500 ep)"],
  bigProfile.topFunctions[phase].slice(0, n).map((f) => [`<code>${esc(f.name)}</code>`, f1(f.ms)]))
const buildFns = (() => {
  const m = {}
  for (const ph of ["layer", "handler"]) for (const f of bigProfile.topFunctions[ph]) m[f.name] = (m[f.name] ?? 0) + f.ms
  return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 10)
})()
const tblBuildFns = table(["Function (source)", "ms (profiled, 500 ep)"], buildFns.map(([n, ms]) => [`<code>${esc(n)}</code>`, f1(ms)]))
const tblRaw = table(
  ["Endpoints", "eval", "define", "layer", "handler", "first", "second", "openapi", "CPU total", "heap MB", "bundle KB"],
  raw.results.map((r) => [r.endpoints, ...["eval", "define", "layer", "handler", "first", "second", "openapi", "cpuTotal", "heapUsedMB"].map((k) => `${f1(r.stats[k].median)} <span class="muted">/ ${f1(r.stats[k].p95)}</span>`), f0(r.bundleKB)])
)

// ------------------------------------------------------------------ html
const env = data.env
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Effect HttpApi cold-start report</title>
<style>
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb;
  --ink: #0b0b0b; --ink-2: #52514e; --ink-3: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --ring: rgba(11,11,11,0.10);
  --neutral: #b5b4ac;
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100;
  --s5: #e87ba4; --s6: #008300; --s7: #4a3aa7; --s8: #e34948;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19;
    --ink: #ffffff; --ink-2: #c3c2b7; --ink-3: #898781;
    --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,0.10);
    --neutral: #5c5b56;
    --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500;
    --s5: #d55181; --s6: #008300; --s7: #9085e9; --s8: #e66767;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  background: var(--background, var(--page));
  color: var(--foreground, var(--ink));
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 960px; margin: 0 auto; padding: 32px 20px 64px; }
h1 { font-size: 28px; line-height: 1.2; margin: 0 0 6px; font-weight: 650; }
h2 { font-size: 20px; margin: 44px 0 6px; font-weight: 650; }
h3 { font-size: 15px; margin: 24px 0 6px; font-weight: 650; }
p { margin: 8px 0; color: var(--ink-2); }
p b, li b { color: var(--ink); font-weight: 600; }
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
<h1>Effect HttpApi cold-start report</h1>
<p class="sub">effect ${esc(env.effect)} · node ${esc(env.node)} · ${esc(env.platform)} · ${esc(env.cpu)} (${env.cores} cores) · rolldown ${esc(env.rolldown)} · ${env.runs} fresh processes per size · ${env.profileRuns} CPU profiles per size · ${esc(new Date(data.generatedAt).toUTCString())}</p>

<p>How long does an <code>effect/http-api</code> server take to go from a brand-new process to its first response, and how does that grow with the number of endpoints? Each sample is a fresh <code>node</code> process running a single rolldown bundle (the way a Cloudflare Worker ships), with APIs of <b>${E.join(", ")}</b> endpoints.</p>

<div class="tiles">
  <div class="tile"><div class="label">Ready at ${largest.endpoints} endpoints</div><div class="value">${f0(r500.ready)} <small>ms</small></div><div class="note">process start → first response; p95 ${f0(largest.p95.ready)} ms</div></div>
  <div class="tile"><div class="label">Cost per endpoint</div><div class="value">${f0(fits.init.slope * 1000)} <small>µs</small></div><div class="note">define + build + first request, linear fit R² ${fits.init.r2.toFixed(3)}</div></div>
  <div class="tile"><div class="label">Fixed module load</div><div class="value">${f0(smallest.med.moduleLoad)} <small>ms</small></div><div class="note">${f0(undiciMs)} ms is Node initializing undici; ~${f0(effectOwnLoad)} ms is parsing + running Effect</div></div>
  <div class="tile"><div class="label">OpenAPI spec at ${largest.endpoints} endpoints</div><div class="value">${f0(r500.openapi)} <small>ms</small></div><div class="note">${f0(fits.openapi.slope * 1000)} µs/endpoint, but only when docs are first requested</div></div>
</div>

<div class="callout">
<p><b>Summary.</b> Startup is a fixed ~${f0(smallest.med.ready)} ms (${f0(B)} ms Node bootstrap + ${f0(smallest.med.moduleLoad)} ms module load + ~${f0(smallest.med.init)} ms to build and serve) plus a <b>linear ~${f0(fits.init.slope * 1000)} µs per endpoint</b>, split almost evenly between <b>defining the API</b> (${f0(fits.define.slope * 1000)} µs, mostly Schema construction) and <b>building the handler</b> (${f0(fits.build.slope * 1000)} µs, router registration + per-endpoint codecs). At ${largest.endpoints} endpoints, API work overtakes module load: ${f0(r500.define + r500.build)} ms vs ${f0(r500.moduleLoad)} ms. The first request costs a flat ~${f1(r500.first)} ms regardless of size because everything is built eagerly in <code>toWebHandler</code>.</p>
</div>

<h2>1 · Where the time goes</h2>
<p>Medians per phase, stacked in execution order. <b>Module load</b> is parse/compile + evaluation of the bundle (measured as time-to-first-harness-line minus an empty Node process). <b>Define API</b> is <code>HttpApi.make(…).add(…)</code> including all schemas. <b>Build handler</b> is <code>HttpApiBuilder.group/layer</code> + <code>HttpRouter.toWebHandler</code>, which builds the layer, every route and the router tree. <b>First request</b> is one <code>GET /r0/1</code>.</p>
<div class="card"><h4>Process start → first response</h4><p class="caption">median ms per phase · hover for values</p><div class="chart" data-chart="waterfall"></div>${details("Table view", tblWaterfall)}</div>
<p>At 1 endpoint ${pct(B + smallest.med.moduleLoad, smallest.med.ready)} of the time is fixed (Node + module load). At ${largest.endpoints} endpoints the API-dependent phases are ${pct(r500.define + r500.build, r500.ready)} of the total. Whole-process CPU is ${f0(largest.med.cpuTotal)} ms against ${f0(r500.ready)} ms wall time at ${largest.endpoints} endpoints: V8's concurrent GC and compiler threads add CPU beyond the main thread, which matters for platforms that bill or cap all CPU.</p>

<h2>2 · How it grows</h2>
<p>Every API-dependent phase grows <b>linearly</b> with endpoint count (R² ≥ ${Math.min(fits.define.r2, fits.build.r2, fits.openapi.r2).toFixed(3)}), with no super-linear term up to ${largest.endpoints} endpoints. The cost per endpoint does <b>fall at small sizes</b> before settling: the first endpoints cost ${f0(marginalRaw[0])} µs each, while from 50 endpoints on it's ~${f0(marginalRaw.at(-1))} µs. That pattern fits V8 running the definition and build code cold (interpreted, unoptimized) at first and optimizing it once it gets hot. Module load barely moves (+${f1(fits.moduleLoad.slope * 1000)} µs/endpoint, from parsing the generated API code), and the first request is flat.</p>
<div class="card"><h4>Phase time vs endpoint count</h4><p class="caption">median ms · linear x axis · hover for values</p><div class="chart" data-chart="growth"></div>${details("Table view", tblGrowth)}</div>
<div class="cols">
<div><h3>Linear fit per phase</h3>${tblFits}</div>
<div><h3>Marginal cost between sizes</h3><p>Per-endpoint cost between consecutive sizes. It is higher for the first endpoints, while code is still running cold, and flat from 50 endpoints on.</p>${tblMarginal}</div>
</div>

<h2>3 · What the per-endpoint cost is made of</h2>
<p>CPU profiles (${env.profileRuns} per size, ${env.profileIntervalUs} µs sampling) are split by phase using monotonic timestamps from the harness, then each sample is attributed to an Effect source file through the bundle sourcemap and grouped. Category times are the profile's shares scaled to the un-profiled medians, and the per-endpoint figure is the linear-fit slope of each category across the five sizes.</p>
<div class="card"><h4>Per-endpoint cost by category</h4><p class="caption">µs per additional endpoint · hover for values</p><div class="chart" data-chart="perEndpoint"></div>${details("Table view", tblPerEndpoint)}</div>
<ul>
<li><b>Define API (${f0(sumPer("define"))} µs/ep).</b> Dominated by <b>Schema</b> (${f0(perEndpoint.define.Schema)} µs): every endpoint builds new struct/param/payload/error ASTs (<code>schema/make.ts</code>, <code>SchemaAST.struct</code>), plus <b>HttpApi definition</b> bookkeeping (${f0(perEndpoint.define["HttpApi definition"])} µs), including <code>validateResponseExclusivity</code> run for every endpoint, and <code>pipe</code>/<code>dual</code> overhead (${f0(perEndpoint.define["pipe / dual / predicates"])} µs).</li>
<li><b>Build handler (${f0(sumPer("build"))} µs/ep).</b> The single biggest category is the <b>router</b> (${f0(perEndpoint.build["Router (FindMyWay)"])} µs/ep, ${pct(routerShare500 * r500.build, r500.build)} of this phase at ${largest.endpoints} endpoints vs ${pct(routerShare1 * smallest.med.build, smallest.med.build)} at 1): <code>FindMyWay</code>'s <code>_on</code> does string slicing, <code>toLowerCase</code> and <code>split/join</code> per route segment. Next are <b>HttpApiBuilder</b> (${f0(perEndpoint.build.HttpApiBuilder)} µs: <code>handlerToRoute</code>, per-endpoint encoders and decoders), the <b>Effect runtime/Layer</b> work that runs it (${f0(perEndpoint.build["Effect runtime & Layer"])} µs), and <b>Schema</b> codec derivation (${f0(perEndpoint.build.Schema)} µs: <code>SchemaAST.copy</code>, <code>make</code>).</li>
<li><b>GC</b> is ${f0(perEndpoint.define["Garbage collector"] + perEndpoint.build["Garbage collector"])} µs/ep across define + build: these phases allocate a lot of short-lived AST/closure objects. Heap used grows ~${f0(fits.heap.slope * 1024)} KB per endpoint.</li>
</ul>
<div class="cols">
<div class="card"><h4>Build handler, by size</h4><p class="caption">ms (scaled) · router share grows with size</p><div class="chart" data-chart="buildMix"></div>${details("Table view", catTable("build"))}</div>
<div class="card"><h4>Define API, by size</h4><p class="caption">ms (scaled) · Schema dominates throughout</p><div class="chart" data-chart="defineMix"></div>${details("Table view", catTable("define"))}</div>
</div>
<h3>Hottest functions at ${largest.endpoints} endpoints</h3>
<p class="sub">Self time from the profiler (inflated by sampling overhead; compare relatively). <code>(bundle):1</code> is code without a source mapping.</p>
<div class="cols">
<div>${details("Define API: top functions", fnTable("define"))}</div>
<div>${details("Build handler: top functions", tblBuildFns)}</div>
</div>

<h2>4 · Module load: the fixed cost</h2>
<p>Module load takes ~${f0(smallest.med.moduleLoad)} ms at every size. Profiling shows Effect's own top-level code is only a small part of it:</p>
<div class="card"><h4>Inside module load</h4><p class="caption">ms, profile shares scaled to the measured median, averaged over all sizes</p><div class="chart" data-chart="evalMix"></div>${details("Table view", tblEval)}</div>
<ul>
<li><b>Node initializing undici (~${pct(evalAvg["Node: undici init"], smallest.med.moduleLoad)}).</b> <code>Schema.ts</code> builds <code>instanceOf(globalThis.FormData)</code> at module scope. In Node, <code>FormData</code>/<code>Request</code>/<code>Headers</code> are lazy getters, and the first touch loads undici and its dependencies (crypto, zlib, streams): ${f0(exp?.emptyProcessFormDataTouchMs ?? undiciMs)} ms even in an empty process.</li>
<li><b>Parsing & compiling the bundle (~${pct(evalAvg["Parse & compile bundle"], smallest.med.moduleLoad)}).</b> Proportional to bundle size: minifying (${f0(minRows[0].bundleKB)} KB vs ${f0(smallest.bundleKB)} KB) cuts module load from ${f0(smallest.med.moduleLoad)} to ${f0(minLoad)} ms.</li>
<li><b>Effect's module top-level code</b> (creating services, tags, schema singletons) is ~${f0(evalAvg["Effect module top-level code"])} ms.</li>
</ul>
${exp ? `<div class="card"><h4>A/B: removing the one module-scope <code>globalThis.FormData</code> reference</h4><p class="caption">${exp.size} API, median of ${exp.runs} runs · the cost moves, it doesn't vanish, because the harness itself calls <code>new Request()</code></p><div class="chart" data-chart="experiment"></div>${details("Table view", tblExperiment)}</div>
<p>Patching out that single reference drops module load from ${f0(exp.baseline.eval - B)} to <b>${f0(exp.withoutFormData.eval - B)} ms</b>; the same ~${f0(undiciMs)} ms then shows up in the first request (${f1(exp.baseline.first)} → ${f1(exp.withoutFormData.first)} ms) because the harness builds a <code>Request</code>. Total is unchanged <i>on Node with web handlers</i>. It matters elsewhere: <b>on workerd</b> these globals are native, so Effect's real load cost there is closer to ${f0(exp.withoutFormData.eval - B)} ms than ${f0(exp.baseline.eval - B)}; and a <b>Node server using <code>node:http</code></b> (e.g. <code>NodeHttpServer</code>) never needs undici, so for it the reference is ~${f0(undiciMs)} ms of pure waste.</p>` : ""}

<h2>5 · Bundle size</h2>
<p>The unminified bundle starts at ${f0(smallest.bundleKB)} KB and grows ~${f1(fits.bundleKB.slope)} KB per endpoint, which is just the generated API code. Effect's share is the same at every size: HttpApi always pulls in Schema, the HTTP server stack (request/response, headers, cookies, multipart parsing), streams and the router, whether the API uses them or not.</p>
<div class="card"><h4>Bundle composition</h4><p class="caption">KB of output per source category (unminified)</p><div class="chart" data-chart="bundle"></div>${details("Table view", tblBytes)}</div>
${details("Minified vs unminified", tblBundle)}

<h2>6 · OpenAPI generation</h2>
<p><code>OpenApi.fromApi</code> is the most expensive per-endpoint operation measured: <b>${f0(fits.openapi.slope * 1000)} µs/endpoint</b>, ${f0(r500.openapi)} ms at ${largest.endpoints} endpoints, with GC as its largest category (${f0(perEndpoint.openapi["Garbage collector"])} µs/ep). Hot spots: JSON-schema document recursion (<code>toJsonSchemaDocument</code>), <code>cloneOpenAPISpec</code> and <code>assignProperty</code>. It is <b>not</b> part of cold start: <code>HttpApiScalar</code>, <code>HttpApiSwagger</code> and <code>openapiPath</code> all memoize it on first request. Whoever first opens <code>/docs</code> on a fresh isolate pays it, though.</p>
${details("OpenAPI: top functions", fnTable("openapi"))}

<h2>7 · Leads for reducing cold start</h2>
<ol>
<li><b>Defer route compilation.</b> Build handler cost is per endpoint and paid upfront. Compiling each route's codecs (<code>handlerToRoute</code>, <code>SchemaAST.copy</code>/<code>make</code>) on its first hit would make cold start pay only for the routes actually used: about ${f0(perEndpoint.build.HttpApiBuilder + perEndpoint.build.Schema + perEndpoint.build["Effect runtime & Layer"])} of the ${f0(sumPer("build"))} µs/ep.</li>
<li><b>Cheaper route registration.</b> <code>FindMyWay._on</code>/<code>on</code> is the top self-time function in the build phase. Per-segment <code>split("::").join(":")</code>, <code>split("%").join("%25")</code> and <code>toLowerCase</code> could be skipped for segments without those characters, or the tree could be built lazily on first lookup.</li>
<li><b>Lighter API definitions.</b> Schema construction dominates <code>define</code>. Reusing schema instances across endpoints helps users; on the library side, <code>validateResponseExclusivity</code> and the <code>dual</code>/<code>pipe</code> layers show up per endpoint.</li>
<li><b>Lazy <code>FormData</code>/<code>File</code> guards</b> in <code>Schema.ts</code> (reference the global inside the check, not at module scope) save ~${f0(undiciMs)} ms on Node servers that don't otherwise touch undici.</li>
<li><b>Minify</b> in deployment: about −${f0(smallest.med.moduleLoad - minLoad)} ms of parse/compile for free.</li>
</ol>

<h2>Methodology</h2>
<ul>
<li><b>API shape.</b> <code>G</code> groups × <code>E</code> endpoints (here ${data.sizes.map((s) => `${s.groups}×${s.endpoints}`).join(", ")}). Each group is a REST resource: an entity struct (int, strings, literal union, optional number, array, nested struct), create/update payloads, a <code>TaggedError</code> 404 and a struct 409. Endpoints are list (query params), get, create, update, delete, then <code>actionN</code> endpoints with their own payload/success schemas, all with trivial handlers.</li>
<li><b>Process model.</b> Harness + API bundled by rolldown into one ESM file (<code>platform: "neutral"</code>, JSDoc stripped, not minified unless stated). Effect resolves from the published npm package exactly like an app. Two warmup processes per size, then ${env.runs} measured, sequentially. Node's compile cache is off.</li>
<li><b>Phases</b> are timed with <code>performance.now()</code> inside the process. Module load = time-to-first-harness-line − median time-to-first-line of an empty script (${f1(B)} ms).</li>
<li><b>Attribution.</b> <code>--cpu-prof</code> at ${env.profileIntervalUs} µs; samples are assigned to phases with <code>process.hrtime</code> marks (the profiler's own clock), and to sources via sourcemaps chained into Effect's <code>.ts</code> files. Before the harness runs, samples are classed as bundle compile (under <code>compileSourceTextModule</code>), module code (bundle frame on stack) or Node bootstrap. <code>node:</code> frames under an undici frame count as undici init.</li>
<li><b>Caveats.</b> Node is not workerd: V8 is the same, so scaling and hot spots carry over, but absolute times and the undici cost do not. The profiler inflates absolute times by ~${f0((attribution.at(-1) && (data.profiles.at(-1).categoriesMs.handler ? Object.values(data.profiles.at(-1).categoriesMs.handler).reduce((a, b) => a + b, 0) : 0) / largest.med.build - 1) * 100)}%, so category times are shares scaled to un-profiled medians.</li>
</ul>
${details("Raw medians / p95 (ms) for every phase", tblRaw)}
<p class="sub">Reproduce: <code>node scripts/collect.mjs &amp;&amp; node scripts/experiment-formdata.mjs &amp;&amp; node scripts/render-report.mjs</code></p>
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
  const W = mount.clientWidth, labelW = Math.min(150, Math.max(...c.rows.map((r) => r.label.length)) * 7.2 + 12), right = 64;
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
  const W = mount.clientWidth, H = 300, left = 44, right = 150, top = 10, bottom = 34;
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
    const t = svgEl("text", { x: X(xmax) + 10, y: e.y + 4, class: "lbl" }, svg);
    t.textContent = e.s.label.replace(" (on demand)", "") + " " + (e.v >= 100 ? Math.round(e.v) : e.v.toFixed(1));
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
