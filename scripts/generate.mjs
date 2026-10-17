// Generates a synthetic, realistically shaped HttpApi with `groups` x `endpoints`.
//
// Each group models a REST resource: an entity schema with a mix of field kinds,
// a create/update payload, a NotFound error, and CRUD endpoints. Extra endpoints
// beyond the 5 CRUD ones are "action" endpoints with their own payload/success
// schemas, so schema count scales with endpoint count (as in real APIs).
//
// The generated module exports a `run(mark)` function so the harness can time
// each phase. Everything a real app would do at module scope happens inside it.

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

export function generateSource({ groups, endpoints }) {
  const out = []
  out.push(`import { Effect, Layer, Schema } from "effect"`)
  out.push(`import { HttpRouter } from "effect/http"`)
  out.push(`import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"`)
  out.push(``)
  out.push(`export const meta = ${JSON.stringify({ groups, endpoints, total: groups * endpoints })}`)
  out.push(``)
  out.push(`export function defineApi() {`)
  out.push(`  const Address = Schema.Struct({ street: Schema.String, city: Schema.String, zip: Schema.String, country: Schema.String })`)
  out.push(`  let api = HttpApi.make("BenchApi")`)
  for (let g = 0; g < groups; g++) {
    const R = `R${g}`
    out.push(`  {`)
    out.push(`    const Entity = Schema.Struct({`)
    out.push(`      id: Schema.Int,`)
    out.push(`      name: Schema.NonEmptyString,`)
    out.push(`      email: Schema.String,`)
    out.push(`      status: Schema.Literals(["active", "inactive", "pending"]),`)
    out.push(`      createdAt: Schema.String,`)
    out.push(`      tags: Schema.Array(Schema.String),`)
    out.push(`      score: Schema.optional(Schema.Finite),`)
    out.push(`      enabled: Schema.Boolean,`)
    out.push(`      address: Address`)
    out.push(`    }).annotate({ identifier: "${R}" })`)
    out.push(`    const Create = Schema.Struct({ name: Schema.NonEmptyString, email: Schema.String, tags: Schema.Array(Schema.String), address: Address })`)
    out.push(`    const Update = Schema.Struct({ name: Schema.optional(Schema.NonEmptyString), email: Schema.optional(Schema.String), status: Schema.optional(Schema.Literals(["active", "inactive", "pending"])) })`)
    out.push(`    class NotFound extends Schema.TaggedError()("${R}NotFound", { id: Schema.Int }, { httpApiStatus: 404 }) {}`)
    out.push(`    const Conflict = Schema.Struct({ _tag: Schema.tag("${R}Conflict"), message: Schema.String }).annotate({ httpApiStatus: 409 })`)
    out.push(`    api = api.add(HttpApiGroup.make("${R.toLowerCase()}").add(`)
    const eps = []
    for (let e = 0; e < endpoints; e++) {
      const base = `/${R.toLowerCase()}`
      switch (e) {
        case 0:
          eps.push(`HttpApiEndpoint.get("list", "${base}", { query: { limit: Schema.optional(Schema.NumberFromString), offset: Schema.optional(Schema.NumberFromString), status: Schema.optional(Schema.Literals(["active", "inactive", "pending"])) }, success: Schema.Struct({ items: Schema.Array(Entity), total: Schema.Int }) })`)
          break
        case 1:
          eps.push(`HttpApiEndpoint.get("get", "${base}/:id", { params: { id: Schema.NumberFromString }, success: Entity, error: NotFound })`)
          break
        case 2:
          eps.push(`HttpApiEndpoint.post("create", "${base}", { payload: Create, success: Entity, error: Conflict })`)
          break
        case 3:
          eps.push(`HttpApiEndpoint.patch("update", "${base}/:id", { params: { id: Schema.NumberFromString }, payload: Update, success: Entity, error: [NotFound, Conflict] })`)
          break
        case 4:
          eps.push(`HttpApiEndpoint.delete("remove", "${base}/:id", { params: { id: Schema.NumberFromString }, error: NotFound })`)
          break
        default:
          eps.push(`HttpApiEndpoint.post("action${e}", "${base}/:id/action${e}", { params: { id: Schema.NumberFromString }, payload: Schema.Struct({ reason: Schema.String, force: Schema.optional(Schema.Boolean), count${e}: Schema.Int }), success: Schema.Struct({ ok: Schema.Boolean, entity: Entity }), error: NotFound })`)
      }
    }
    out.push(`      ${eps.join(",\n      ")}`)
    out.push(`    ))`)
    out.push(`  }`)
  }
  out.push(`  return api`)
  out.push(`}`)
  out.push(``)
  out.push(`const entity = (id) => ({ id, name: "n", email: "e@x.io", status: "active", createdAt: "2026-01-01", tags: ["a"], enabled: true, address: { street: "s", city: "c", zip: "z", country: "x" } })`)
  out.push(``)
  out.push(`export function defineLayer(Api) {`)
  out.push(`  const groups = []`)
  for (let g = 0; g < groups; g++) {
    const name = `r${g}`
    const handlers = []
    for (let e = 0; e < endpoints; e++) {
      switch (e) {
        case 0: handlers.push(`.handle("list", () => Effect.succeed({ items: [entity(1)], total: 1 }))`); break
        case 1: handlers.push(`.handle("get", ({ params }) => Effect.succeed(entity(params.id)))`); break
        case 2: handlers.push(`.handle("create", () => Effect.succeed(entity(1)))`); break
        case 3: handlers.push(`.handle("update", ({ params }) => Effect.succeed(entity(params.id)))`); break
        case 4: handlers.push(`.handle("remove", () => Effect.void)`); break
        default: handlers.push(`.handle("action${e}", ({ params }) => Effect.succeed({ ok: true, entity: entity(params.id) }))`)
      }
    }
    out.push(`  groups.push(HttpApiBuilder.group(Api, "${name}", (h) => h${handlers.join("")}))`)
  }
  out.push(`  return HttpApiBuilder.layer(Api).pipe(Layer.provide(Layer.mergeAll(...groups)))`)
  out.push(`}`)
  out.push(``)
  out.push(`export const toWebHandler = (layer) => HttpRouter.toWebHandler(layer, { disableLogger: true })`)
  out.push(`export const openApi = (Api) => OpenApi.fromApi(Api)`)
  return out.join("\n") + "\n"
}

export function writeApi(size) {
  const file = join(root, "generated", `api-${size.groups}x${size.endpoints}.mjs`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, generateSource(size))
  return file
}

export const parseSize = (s) => {
  const [groups, endpoints] = s.split("x").map(Number)
  if (!groups || !endpoints) throw new Error(`invalid size "${s}", expected <groups>x<endpoints>`)
  return { groups, endpoints }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sizes = (process.argv[2] ?? "1x5,10x10,50x10").split(",").map(parseSize)
  for (const s of sizes) console.log(writeApi(s))
}
