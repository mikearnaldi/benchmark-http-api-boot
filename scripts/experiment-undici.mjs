// A/B: Node initializing undici during startup, and what triggers it.
//
//   node scripts/experiment-undici.mjs [--size 10x10] [--runs 25]
//
// Two independent triggers load undici (~30 ms) on Node 24:
//  1. effect's Schema evaluates `instanceOf(globalThis.FormData)` at module
//     scope (FormData is a lazy, undici-backed global).
//  2. an ESM `import ... from "node:http"` snapshots every export of the module,
//     including the lazy undici-backed `WebSocket`/`CloseEvent`/`MessageEvent`
//     getters. `process.getBuiltinModule("node:http")` does not.
//
// Web-handler mode: bundle as shipped vs. FormData reference stubbed out.
// Server mode (real node:http server + HTTP request): as shipped, each trigger
// removed alone, both removed. Variants are made by patching the bundle text.
import { execFileSync, spawn } from "node:child_process"
import * as http from "node:http"
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
const runs = Number(opts.runs)
const apiFile = writeApi(parseSize(opts.size))
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1]

const patchOnce = (source, pattern, replacement, what) => {
  const hits = source.match(pattern)?.length ?? 0
  if (hits === 0) throw new Error(`patch "${what}": pattern not found`)
  return source.replace(pattern, replacement)
}
const noFormData = (s) => patchOnce(s, /instanceOf\(globalThis\.FormData,/g, "instanceOf(class FormDataStub {},", "FormData")
const noHttpImport = (s) =>
  patchOnce(
    patchOnce(s, /^import \* as (\w+) from "node:http";$/gm, (_, id) => `const ${id} = process.getBuiltinModule("node:http");`, "import * from node:http"),
    /^import \{ ([^}]+) \} from "node:http";$/gm,
    (_, names) => `const { ${names.replace(/ as /g, ": ")} } = process.getBuiltinModule("node:http");`,
    "import {} from node:http"
  )
const undiciLoaded = (file) => {
  // Re-run once with a probe appended to the "ready"/end of startup.
  const probe = file.replace(/\.mjs$/, "-probe.mjs")
  writeFileSync(probe, readFileSync(file, "utf8") + `\nsetTimeout(() => { process.stdout.write("UNDICI=" + process.moduleLoadList.some((m) => m.includes("undici")) + "\\n"); process.exit(0) }, 300)\n`)
  const out = execFileSync(process.execPath, [probe], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, BENCH_OPENAPI: "0" } })
  return /UNDICI=true/.test(out)
}

// ------------------------------------------------------------ web handler
const handler = await bundle({ apiFile, outFile: join(root, "dist", "experiment", `api-${opts.size}.mjs`) })
const handlerSrc = readFileSync(handler.outFile, "utf8")
const handlerNoFd = handler.outFile.replace(/\.mjs$/, "-no-formdata.mjs")
writeFileSync(handlerNoFd, noFormData(handlerSrc))
const runHandler = (f) => JSON.parse(execFileSync(process.execPath, [f], { encoding: "utf8", env: { ...process.env, BENCH_OPENAPI: "0" } }))
const measureHandler = (f) => {
  runHandler(f)
  runHandler(f)
  const s = Array.from({ length: runs }, () => runHandler(f))
  return Object.fromEntries(["eval", "define", "handler", "first", "total"].map((k) => [k, median(s.map((x) => x[k]))]))
}

// ------------------------------------------------------------ server
const server = await bundle({ apiFile, outFile: join(root, "dist", "experiment", `server-${opts.size}.mjs`), mode: "server" })
const serverSrc = readFileSync(server.outFile, "utf8")
const variants = {
  "As shipped": serverSrc,
  "FormData ref removed": noFormData(serverSrc),
  "node:http via getBuiltinModule": noHttpImport(serverSrc),
  "Both removed": noHttpImport(noFormData(serverSrc))
}
const variantFiles = Object.fromEntries(Object.entries(variants).map(([name, src], i) => {
  const f = server.outFile.replace(/\.mjs$/, `-v${i}.mjs`)
  writeFileSync(f, src)
  return [name, f]
}))
const runServer = (file) => new Promise((resolve, reject) => {
  const t0 = performance.now()
  const child = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "inherit"] })
  let buf = ""
  child.stdout.on("data", (d) => {
    buf += d
    let i
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      if (!m.ready) continue
      http.get({ host: "127.0.0.1", port: m.port, path: "/r0/1", agent: false }, (res) => {
        res.resume()
        res.on("end", () => {
          child.kill()
          resolve({ moduleLoad: m.eval, coldStart: performance.now() - t0 })
        })
      }).on("error", (e) => (child.kill(), reject(e)))
    }
  })
})
const measureServer = async (f) => {
  await runServer(f)
  await runServer(f)
  const s = []
  for (let i = 0; i < runs; i++) s.push(await runServer(f))
  return { moduleLoad: median(s.map((x) => x.moduleLoad)), coldStart: median(s.map((x) => x.coldStart)) }
}

const probe = Number(execFileSync(process.execPath, ["-e", "const t=performance.now();globalThis.FormData;process.stdout.write(String(performance.now()-t))"], { encoding: "utf8" }))
const importHttp = Number(execFileSync(process.execPath, ["--input-type=module", "-e", "const t=performance.now();await import('node:http');process.stdout.write(String(performance.now()-t))"], { encoding: "utf8" }))
const builtinHttp = Number(execFileSync(process.execPath, ["-e", "const t=performance.now();process.getBuiltinModule('node:http');process.stdout.write(String(performance.now()-t))"], { encoding: "utf8" }))

const result = {
  size: opts.size,
  runs,
  node: process.version,
  isolated: { touchFormDataMs: probe, esmImportNodeHttpMs: importHttp, getBuiltinModuleNodeHttpMs: builtinHttp },
  handler: { baseline: measureHandler(handler.outFile), withoutFormData: measureHandler(handlerNoFd) },
  server: {}
}
for (const [name, f] of Object.entries(variantFiles)) {
  result.server[name] = { ...(await measureServer(f)), undiciLoaded: undiciLoaded(f) }
  console.log(name, result.server[name])
}
writeFileSync(join(root, "reports", "experiment-undici.json"), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result.isolated), JSON.stringify(result.handler))
