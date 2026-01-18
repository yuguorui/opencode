#!/usr/bin/env bun

const dir = new URL("..", import.meta.url).pathname
process.chdir(dir)

const pkg = await import("../package.json").then((m) => m.default)
const next = JSON.parse(JSON.stringify(pkg))

const items = Object.entries(next.exports)
for (const item of items) {
  const key = item[0]
  const value = item[1]
  const data =
    typeof value === "object" && value !== null && "import" in value
      ? (value as { import?: unknown }).import
      : undefined
  const text = typeof value === "string" ? value : data
  if (typeof text !== "string") continue
  const file = text.replace("./src/", "./dist/").replace(".ts", "")
  next.exports[key] = {
    import: file + ".js",
    types: file + ".d.ts",
  }
}

await Bun.write("package.json", JSON.stringify(next, null, 2))
