// A/B: how much of module evaluation is Node lazily initializing undici because
// effect's Schema touches `globalThis.FormData` at module scope?
//
//   node scripts/experiment-formdata.mjs [--size 10x10] [--runs 25]
//
// Bundles the API normally, then makes a copy where only that module-scope
// `globalThis.FormData` reference is replaced by a stub class. On Node the
// undici cost then moves to the first `new Request()`; on workerd (native
// Request/FormData) it would not exist at all.
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { bundle } from "./bundle.mjs"
import { parseSize, writeApi } from "./generate.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const { values: opts } = parseArgs({
  options: { size: { type: "string", default: "10x10" }, runs: { type: "string", default: "25" } }
})

const { outFile } = await bundle({
  apiFile: writeApi(parseSize(opts.size)),
  outFile: join(root, "dist", "experiment", `api-${opts.size}.mjs`)
})
const source = readFileSync(outFile, "utf8")
const pattern = /instanceOf\(globalThis\.FormData,/g
const hits = source.match(pattern)?.length ?? 0
if (hits !== 1) throw new Error(`expected exactly one module-scope FormData instanceOf, found ${hits}`)
const patched = outFile.replace(/\.mjs$/, "-no-formdata.mjs")
writeFileSync(patched, source.replace(pattern, "instanceOf(class FormDataStub {},"))

const run = (f) => JSON.parse(execFileSync(process.execPath, [f], { encoding: "utf8", env: { ...process.env, BENCH_OPENAPI: "0" } }))
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1]
const measure = (f) => {
  run(f)
  run(f)
  const s = Array.from({ length: Number(opts.runs) }, () => run(f))
  return Object.fromEntries(["eval", "define", "handler", "first", "total"].map((k) => [k, median(s.map((x) => x[k]))]))
}
// Cost of touching the global in an otherwise empty process.
const probe = Array.from({ length: 10 }, () =>
  Number(execFileSync(process.execPath, ["-e", "const t=performance.now();globalThis.FormData;process.stdout.write(String(performance.now()-t))"], { encoding: "utf8" })))

const result = {
  size: opts.size,
  runs: Number(opts.runs),
  baseline: measure(outFile),
  withoutFormData: measure(patched),
  emptyProcessFormDataTouchMs: median(probe)
}
writeFileSync(join(root, "reports", "experiment-formdata.json"), JSON.stringify(result, null, 2))
console.log(result)
