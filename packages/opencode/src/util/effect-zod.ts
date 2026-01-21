import { Schema } from "effect"
import z from "zod"

/**
 * Convert an Effect Schema to a Zod schema via JSON Schema intermediate.
 */
export function zod(schema: Schema.Schema<unknown>): z.ZodTypeAny {
  const doc = Schema.toJsonSchemaDocument(schema, { additionalProperties: true })
  return jsonSchemaToZod(doc.schema, doc.definitions)
}

function jsonSchemaToZod(schema: unknown, definitions: Record<string, unknown>): z.ZodTypeAny {
  if (!isRecord(schema)) return z.unknown()

  if (typeof schema.$ref === "string") {
    const name = schema.$ref.match(/#\/\$defs\/(.+)/)?.[1] ?? schema.$ref.match(/#\/definitions\/(.+)/)?.[1]
    if (name && definitions?.[name]) return jsonSchemaToZod(definitions[name], definitions)
  }

  if (Array.isArray(schema.anyOf)) {
    const nonNull = schema.anyOf.filter((s: unknown) => !isRecord(s) || s.type !== "null")
    const hasNull = schema.anyOf.length > nonNull.length
    if (nonNull.length === 0) return z.null()
    const inner = nonNull.length === 1
      ? jsonSchemaToZod(nonNull[0], definitions)
      : z.union(nonNull.map((s: unknown) => jsonSchemaToZod(s, definitions)))
    return hasNull ? inner.nullable() : inner
  }

  switch (schema.type) {
    case "string": {
      let zodStr = z.string()
      if (typeof schema.description === "string") zodStr = zodStr.describe(schema.description)
      if (Array.isArray(schema.enum)) return z.enum(schema.enum as [string, ...string[]])
      return zodStr
    }
    case "number":
    case "integer": {
      let zodNum = z.number()
      if (typeof schema.description === "string") zodNum = zodNum.describe(schema.description)
      return zodNum
    }
    case "boolean": {
      let zodBool = z.boolean()
      if (typeof schema.description === "string") zodBool = zodBool.describe(schema.description)
      return zodBool
    }
    case "array": {
      const itemSchema = isRecord(schema.items)
        ? jsonSchemaToZod(schema.items, definitions)
        : z.unknown()
      let zodArr = z.array(itemSchema)
      if (typeof schema.description === "string") zodArr = zodArr.describe(schema.description)
      return zodArr
    }
    case "object": {
      const shape: Record<string, z.ZodTypeAny> = {}
      const required = new Set<string>(
        Array.isArray(schema.required) ? schema.required.filter((r: unknown) => typeof r === "string") : [],
      )
      if (isRecord(schema.properties)) {
        for (const [key, prop] of Object.entries(schema.properties)) {
          let zodProp = jsonSchemaToZod(prop, definitions)
          if (!required.has(key)) zodProp = zodProp.optional()
          shape[key] = zodProp
        }
      }
      let zodObj = z.object(shape)
      if (typeof schema.description === "string") zodObj = zodObj.describe(schema.description)
      return zodObj
    }
    default:
      return z.unknown()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}