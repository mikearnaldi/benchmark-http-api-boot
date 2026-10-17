// Entry point bundled together with one generated API. Runs in a fresh process
// and prints one JSON line of phase timings to stdout.
//
// Phases (ms):
//   eval      process start -> first harness line. Node bootstrap + parse/eval of
//             the whole bundle (effect library + generated module). Compare
//             against the `baseline` bundle to isolate library cost.
//   define    building the HttpApi definition (schemas, groups, endpoints)
//   layer     building the handler Layer value (HttpApiBuilder.group/layer)
//   handler   HttpRouter.toWebHandler(layer)
//   first     first request: layer construction + route registration + request
//   second    second request (steady-state reference)
//   openapi   OpenApi.fromApi(Api), only if BENCH_OPENAPI=1 (run after requests)
import * as Api from "bench:api"

const tEval = performance.now()
const cpu0 = process.cpuUsage()
const t = {}
let last = tEval
// With BENCH_MARKS=1, phase end times are also reported on the monotonic clock
// (µs) that V8 CPU profiles use, so profile samples can be split by phase.
const marks = process.env.BENCH_MARKS === "1" ? { evalEnd: Number(process.hrtime.bigint() / 1000n) } : undefined
const mark = (name) => {
  const now = performance.now()
  t[name] = now - last
  last = now
  if (marks) marks[name] = Number(process.hrtime.bigint() / 1000n)
}

const api = Api.defineApi()
mark("define")
const layer = Api.defineLayer(api)
mark("layer")
const { handler, dispose } = Api.toWebHandler(layer)
mark("handler")
// GET /r0/1 always exists (every generated group has at least `list` + `get`
// when endpoints >= 2; for 1-endpoint groups we hit the list route).
const url = Api.meta.endpoints >= 2 ? "http://localhost/r0/1" : "http://localhost/r0"
const res1 = await handler(new Request(url))
await res1.text()
mark("first")
// Whole-process CPU (all threads) up to the first response: the cold-start CPU bill.
const cpuCold = process.cpuUsage()
const res2 = await handler(new Request(url))
await res2.text()
mark("second")
if (res1.status !== 200 || res2.status !== 200) {
  throw new Error(`unexpected status ${res1.status}/${res2.status}`)
}
if (process.env.BENCH_OPENAPI === "1") {
  Api.openApi(api)
  mark("openapi")
}
const cpu = process.cpuUsage()
const total = performance.now()
await dispose()

// BENCH_WARM=N: after the cold pass, rebuild everything N more times in the
// same process (fresh API, layer, handler, request each time) and report the
// last iteration. Same work, but V8 has already compiled and optimized the
// code paths, so cold - warm = the cold-code penalty.
const warm = {}
const warmRuns = Number(process.env.BENCH_WARM ?? 0)
for (let i = 0; i < warmRuns; i++) {
  let w = performance.now()
  const lap = (name) => {
    const now = performance.now()
    warm[name] = now - w
    w = now
  }
  const api2 = Api.defineApi()
  lap("warmDefine")
  const layer2 = Api.defineLayer(api2)
  lap("warmLayer")
  const web2 = Api.toWebHandler(layer2)
  lap("warmHandler")
  const res = await web2.handler(new Request(url))
  await res.text()
  lap("warmFirst")
  if (res.status !== 200) throw new Error(`unexpected warm status ${res.status}`)
  await web2.dispose()
}

process.stdout.write(JSON.stringify({
  eval: tEval,
  ...t,
  total,
  cpuColdStart: (cpuCold.user + cpuCold.system) / 1000,
  ...warm,
  // CPU time spent from first harness line to the end of the last phase.
  cpuAfterEval: (cpu.user - cpu0.user + cpu.system - cpu0.system) / 1000,
  // CPU time for the whole process, including bootstrap + eval.
  cpuTotal: (cpu.user + cpu.system) / 1000,
  heapUsedMB: process.memoryUsage().heapUsed / 1048576,
  ...(marks ? { marks } : {})
}) + "\n")
