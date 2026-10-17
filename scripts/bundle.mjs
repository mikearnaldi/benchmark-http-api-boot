// Bundles harness + one generated API into a single ESM file (like a Worker),
// using rolldown.
//
// By default `effect` resolves from this project's node_modules (the published
// npm package), exactly like a client app. `effectPkg` (optional) is either a
// packed tarball (.tgz) or a *built* package directory (e.g. a checkout's
// `packages/effect` after `pnpm build`). A directory is run through `pnpm pack`
// first, because the repo's package.json `exports` point at src/*.ts and only
// `publishConfig` (applied when packing) switches them to dist/. The extracted
// tarball is then resolved like an installed dependency.
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { rolldown } from "rolldown"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

const installed = new Map()
const installPackage = (pkg) => {
  if (installed.has(pkg)) return installed.get(pkg)
  let tarball = pkg
  if (!pkg.endsWith(".tgz")) {
    if (!existsSync(join(pkg, "dist"))) {
      throw new Error(`${pkg} has no dist/ — build it first (pnpm build in packages/effect)`)
    }
    const dest = mkdtempSync(join(tmpdir(), "effect-pack-"))
    execFileSync("pnpm", ["pack", "--pack-destination", dest], { cwd: pkg, stdio: "ignore" })
    tarball = join(dest, readdirSync(dest).find((f) => f.endsWith(".tgz")))
  }
  // dist/.effect-pkg/node_modules/effect = extracted tarball; importer.mjs next
  // to it lets the resolver apply the package's own exports + sideEffects.
  const shim = join(root, "dist", ".effect-pkg")
  rmSync(shim, { recursive: true, force: true })
  mkdirSync(join(shim, "node_modules", "effect"), { recursive: true })
  execFileSync("tar", ["-xzf", tarball, "-C", join(shim, "node_modules", "effect"), "--strip-components=1"])
  const importer = join(shim, "importer.mjs")
  installed.set(pkg, importer)
  return importer
}

const effectPackagePlugin = (pkg) => {
  const importer = installPackage(pkg)
  return {
    name: "effect-package",
    async resolveId(id, from, options) {
      if (!/^effect(\/.*)?$/.test(id) || from === importer) return null
      return this.resolve(id, importer, { ...options, skipSelf: true })
    }
  }
}

// Rolldown doesn't consume `//# sourceMappingURL` of input files, so chain the
// sourcemaps shipped in effect/dist ourselves (only used when profiling).
const inputSourcemapPlugin = () => ({
  name: "input-sourcemap",
  load(id) {
    if (!id.endsWith(".js") || !id.includes("/effect/dist/")) return null
    const code = readFileSync(id, "utf8")
    const m = /\/\/# sourceMappingURL=(\S+)\s*$/.exec(code)
    if (!m || m[1].startsWith("data:")) return null
    const mapFile = join(dirname(id), m[1])
    if (!existsSync(mapFile)) return null
    return { code, map: JSON.parse(readFileSync(mapFile, "utf8")) }
  }
})

// mode "handler": web-handler harness, platform-neutral (Worker-like).
// mode "server":  real node:http server harness (@effect/platform-node).
export async function bundle({ apiFile, outFile, effectPkg, minify = false, sourcemap = false, mode = "handler" }) {
  mkdirSync(dirname(outFile), { recursive: true })
  const build = await rolldown({
    input: join(root, "scripts", mode === "server" ? "harness-server.mjs" : "harness.mjs"),
    platform: mode === "server" ? "node" : "neutral",
    treeshake: true,
    resolve: {
      alias: { "bench:api": resolve(apiFile) },
      mainFields: ["module", "main"],
      conditionNames: ["import", "default"]
    },
    plugins: [
      ...(effectPkg ? [effectPackagePlugin(resolve(effectPkg))] : []),
      ...(sourcemap ? [inputSourcemapPlugin()] : [])
    ],
    logLevel: "warn"
  })
  const { output } = await build.write({
    file: outFile,
    format: "esm",
    minify,
    // Rolldown keeps JSDoc by default (~17k lines of Effect docs); strip it so
    // unminified bundles reflect code, not documentation.
    comments: { legal: true, annotation: false, jsdoc: false },
    // Only for profiling: maps samples back to effect's original .ts sources.
    sourcemap: sourcemap ? "hidden" : false,
    // One file, like a Worker upload.
    codeSplitting: false
  })
  await build.close()
  const chunk = output.find((o) => o.type === "chunk")
  // esbuild-metafile-like shape so per-module sizes can be inspected.
  const inputs = Object.fromEntries(Object.entries(chunk.modules).map(([id, m]) => [id, { bytesInOutput: m.renderedLength }]))
  writeFileSync(outFile + ".meta.json", JSON.stringify({ outputs: { [outFile]: { bytes: Buffer.byteLength(chunk.code), inputs } } }))
  return { outFile, bytes: Buffer.byteLength(chunk.code) }
}
