// Compares two results/*.json files (A = baseline, B = candidate) by median.
//
//   node scripts/compare.mjs results/a.json results/b.json
import { readFileSync } from "node:fs"

const [a, b] = process.argv.slice(2).map((f) => JSON.parse(readFileSync(f, "utf8")))
if (!a || !b) throw new Error("usage: compare.mjs <baseline.json> <candidate.json>")

const phases = ["eval", "define", "handler", "first", "total", "cpuTotal"]
const rows = {}
for (const rb of b.results) {
  const ra = a.results.find((r) => r.size === rb.size)
  if (!ra) continue
  const row = { "bundle KB": `${Math.round(ra.bundleKB)} → ${Math.round(rb.bundleKB)}` }
  for (const p of phases) {
    const x = ra.stats[p].median
    const y = rb.stats[p].median
    row[p] = `${x.toFixed(1)} → ${y.toFixed(1)} (${y >= x ? "+" : ""}${(((y - x) / x) * 100).toFixed(0)}%)`
  }
  rows[`${rb.size} (${rb.endpoints} ep)`] = row
}
console.log(`A: ${a.effect}  B: ${b.effect}  (median ms)`)
console.table(rows)
