// Server-mode entry point: a real Node HTTP server, bundled together with one
// generated API. The bench runner spawns this process, waits for the "ready"
// line, sends one HTTP request over loopback and measures spawn → response.
//
// stdout protocol (one JSON object per line):
//   {"ready":true,"port":N, eval, define, layer, listen}   once listening
//   {"served":true, request, cpuAtResponse, heapUsedMB}    after the 1st response
//
// Phases (ms, measured inside this process):
//   eval     process start → first harness line (Node boot + bundle load)
//   define   HttpApi definition
//   layer    HttpApiBuilder.group/layer values
//   listen   building the server layer: routes, router, NodeHttpServer bound
//   request  server side of the first request: 'request' event → response finished
import { NodeHttpServer } from "@effect/platform-node"
import * as Api from "bench:api"
import { Context, Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { createServer } from "node:http"

const tEval = performance.now()
const t = { eval: tEval }
let last = tEval
const mark = (name) => {
  const now = performance.now()
  t[name] = now - last
  last = now
}

const api = Api.defineApi()
mark("define")
const app = Api.defineLayer(api)
mark("layer")

const server = createServer()
server.once("request", (_req, res) => {
  const start = performance.now()
  res.once("finish", () => {
    const cpu = process.cpuUsage()
    process.stdout.write(JSON.stringify({
      served: true,
      request: performance.now() - start,
      // Whole-process CPU (all threads) when the first response is out.
      cpuAtResponse: (cpu.user + cpu.system) / 1000,
      heapUsedMB: process.memoryUsage().heapUsed / 1048576
    }) + "\n")
  })
})

const Live = HttpRouter.serve(app, { disableLogger: true, disableListenLog: true }).pipe(
  Layer.provideMerge(NodeHttpServer.layer(() => server, { port: 0, host: "127.0.0.1" }))
)

Effect.runFork(Effect.scoped(Effect.gen(function*() {
  const context = yield* Layer.build(Live)
  const { address } = Context.get(context, HttpServer.HttpServer)
  mark("listen")
  process.stdout.write(JSON.stringify({ ready: true, port: address.port, ...t }) + "\n")
  return yield* Effect.never
})))
