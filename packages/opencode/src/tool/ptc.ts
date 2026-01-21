import z from "zod"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./ptc.txt"
import { Session } from "@/session/session"
import { MessageV2 } from "../session/message-v2"
import { PartID, type SessionID, type MessageID } from "../session/schema"
import { ModelID, ProviderID } from "../provider/schema"
import { Agent } from "../agent/agent"
import { zod } from "@/util/effect-zod"
import { EffectBridge } from "@/effect/bridge"

/**
 * Represents a tool that can be called programmatically
 */
interface PTCToolInfo {
  name: string
  description: string
  parameters: Record<string, PTCParameterInfo>
}

interface PTCParameterInfo {
  type: string
  description?: string
  required?: boolean
  enum?: string[]
  items?: PTCParameterInfo
  properties?: Record<string, PTCParameterInfo>
}

/**
 * Context passed to executed JavaScript code
 */
interface PTCContext {
  sessionID: string
  messageID: string
  agent: string
}

/**
 * Result of executing JavaScript code
 */
interface PTCExecutionResult {
  success: boolean
  result?: unknown
  error?: string
  logs: string[]
  toolCalls: PTCToolCallRecord[]
}

/**
 * Record of a tool call made during execution
 */
interface PTCToolCallRecord {
  tool: string
  args: Record<string, unknown>
  result?: string
  error?: string
  duration: number
}

/**
 * Function signature for a generated async tool function
 */
type PTCToolFunction = (args: Record<string, unknown>) => Promise<string>

/**
 * The runtime environment exposed to user code
 */
interface PTCRuntime {
  tools: Record<string, PTCToolFunction>
  log: (...args: unknown[]) => void
  context: PTCContext
}

interface ToolExecutorInfo {
  execute: (args: Record<string, unknown>, callID: string) => Promise<{ output: string; title: string }>
  name: string
}

const DEFAULT_TIMEOUT = 300000 // 5 minutes

/**
 * PTC Executor class - handles JavaScript code execution with tool access
 */
class PTCExecutor {
  private tools: PTCToolInfo[]
  private toolExecutors: Map<string, ToolExecutorInfo>
  private sessionID: SessionID
  private messageID: MessageID
  private session: Session.Interface
  private bridge: EffectBridge.Shape

  constructor(
    tools: PTCToolInfo[],
    toolExecutors: Map<string, ToolExecutorInfo>,
    sessionID: SessionID,
    messageID: MessageID,
    session: Session.Interface,
    bridge: EffectBridge.Shape,
  ) {
    this.tools = tools
    this.toolExecutors = toolExecutors
    this.sessionID = sessionID
    this.messageID = messageID
    this.session = session
    this.bridge = bridge
  }

  async execute(code: string, context: PTCContext): Promise<PTCExecutionResult> {
    const logs: string[] = []
    const callRecords: PTCToolCallRecord[] = []

    const toolFunctions: Record<string, PTCToolFunction> = {}
    for (const tool of this.tools) {
      const safeName = this.sanitizeName(tool.name)
      toolFunctions[safeName] = this.createToolFunction(tool, callRecords)
    }

    const runtime: PTCRuntime = {
      tools: toolFunctions,
      log: (...args: unknown[]) => {
        logs.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "))
      },
      context,
    }

    try {
      const result = await this.executeWithTimeout(code, runtime)
      return {
        success: true,
        result,
        logs,
        toolCalls: callRecords,
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        logs,
        toolCalls: callRecords,
      }
    }
  }

  private createToolFunction(tool: PTCToolInfo, callRecords: PTCToolCallRecord[]): PTCToolFunction {
    return async (args: Record<string, unknown>): Promise<string> => {
      const startTime = Date.now()
      const partID = PartID.ascending()
      const record: PTCToolCallRecord = {
        tool: tool.name,
        args,
        duration: 0,
      }

      const executor = this.toolExecutors.get(tool.name)
      if (!executor) {
        throw new Error(`Tool '${tool.name}' not found in registry`)
      }

      // Update UI: running state
      const runningPart = {
        id: partID,
        messageID: this.messageID,
        sessionID: this.sessionID,
        type: "tool" as const,
        callID: partID,
        tool: tool.name,
        state: {
          status: "running" as const,
          input: args,
          time: { start: startTime },
        },
      } satisfies MessageV2.ToolPart
      await this.bridge.promise(this.session.updatePart(runningPart))

      try {
        const result = await executor.execute(args, partID)
        const output = result.output ?? ""
        record.result = output

        // Update UI: completed state
        const completedPart = {
          id: partID,
          messageID: this.messageID,
          sessionID: this.sessionID,
          type: "tool" as const,
          callID: partID,
          tool: tool.name,
          state: {
            status: "completed" as const,
            input: args,
            output,
            title: result.title,
            metadata: {},
            time: { start: startTime, end: Date.now() },
          },
        } satisfies MessageV2.ToolPart
        await this.bridge.promise(this.session.updatePart(completedPart))

        return output
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        record.error = errorMsg

        // Update UI: error state
        const errorPart = {
          id: partID,
          messageID: this.messageID,
          sessionID: this.sessionID,
          type: "tool" as const,
          callID: partID,
          tool: tool.name,
          state: {
            status: "error" as const,
            input: args,
            error: errorMsg,
            time: { start: startTime, end: Date.now() },
          },
        } satisfies MessageV2.ToolPart
        await this.bridge.promise(this.session.updatePart(errorPart))

        throw err
      } finally {
        record.duration = Date.now() - startTime
        callRecords.push(record)
      }
    }
  }

  private async executeWithTimeout(code: string, runtime: PTCRuntime): Promise<unknown> {
    const wrappedCode = this.wrapCode(code)

    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const fn = new AsyncFunction("tools", "log", "context", wrappedCode)

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Execution timed out after ${DEFAULT_TIMEOUT}ms`))
      }, DEFAULT_TIMEOUT)
    })

    const executionPromise = fn(runtime.tools, runtime.log, runtime.context)

    return Promise.race([executionPromise, timeoutPromise])
  }

  private wrapCode(code: string): string {
    return `
      "use strict";
      ${code}
    `
  }

  private sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_]/g, "_")
  }
}

/**
 * Parse tool parameters from Zod schema
 */
function parseToolParameters(schema: z.ZodType): Record<string, PTCParameterInfo> {
  const parameters: Record<string, PTCParameterInfo> = {}

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape
    for (const [name, paramSchema] of Object.entries(shape)) {
      parameters[name] = parseParameter(paramSchema as z.ZodType, name)
    }
  }

  return parameters
}

function parseParameter(schema: z.ZodType, _name: string): PTCParameterInfo {
  let unwrapped: z.ZodType = schema
  let isOptional = false

  // Unwrap optional/nullable
  if (unwrapped instanceof z.ZodOptional) {
    isOptional = true
    unwrapped = unwrapped.unwrap() as z.ZodType
  }
  if (unwrapped instanceof z.ZodNullable) {
    isOptional = true
    unwrapped = unwrapped.unwrap() as z.ZodType
  }

  const description = schema.description

  if (unwrapped instanceof z.ZodString) {
    return { type: "string", description, required: !isOptional }
  }
  if (unwrapped instanceof z.ZodNumber) {
    return { type: "number", description, required: !isOptional }
  }
  if (unwrapped instanceof z.ZodBoolean) {
    return { type: "boolean", description, required: !isOptional }
  }
  if (unwrapped instanceof z.ZodArray) {
    return {
      type: "array",
      description,
      required: !isOptional,
      items: parseParameter(unwrapped.element as z.ZodType, "item"),
    }
  }
  if (unwrapped instanceof z.ZodObject) {
    const props: Record<string, PTCParameterInfo> = {}
    for (const [key, val] of Object.entries(unwrapped.shape)) {
      props[key] = parseParameter(val as z.ZodType, key)
    }
    return { type: "object", description, required: !isOptional, properties: props }
  }
  if (unwrapped instanceof z.ZodEnum) {
    return { type: "string", description, required: !isOptional, enum: unwrapped.options as string[] }
  }

  return { type: "unknown", description, required: !isOptional }
}

/**
 * Generate TypeScript-style function signatures for tools
 */
function generateFunctionSignatures(tools: PTCToolInfo[]): string {
  const lines: string[] = []

  lines.push("// Available Tools")
  lines.push("")

  for (const tool of tools) {
    const params = Object.entries(tool.parameters)
      .map(([name, param]) => `${name}${param.required ? "" : "?"}: ${mapTypeToTS(param.type)}`)
      .join(", ")

    lines.push(`// ${tool.description}`)
    lines.push(`async function ${sanitizeName(tool.name)}(args: { ${params} }): Promise<string>`)
    lines.push("")
  }

  return lines.join("\n")
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_")
}

function mapTypeToTS(type: string): string {
  switch (type) {
    case "string":
      return "string"
    case "number":
    case "integer":
      return "number"
    case "boolean":
      return "boolean"
    case "array":
      return "unknown[]"
    case "object":
      return "Record<string, unknown>"
    default:
      return "unknown"
  }
}

// Tools that should not be called via PTC:
// - ptc: prevent direct recursion
// - question: requires interactive user input
const DISALLOWED_TOOLS = new Set(["ptc", "question"])

export const PTCTool = Tool.define(
  "ptc",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const agents = yield* Agent.Service

    return {
      description: DESCRIPTION,
      parameters: Schema.Struct({
        code: Schema.String.annotate({ description: "JavaScript code to execute. Must be valid async JavaScript." }),
      }),
      execute: (params: { code: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const run = yield* EffectBridge.make()
          const registry = yield* Effect.promise(() => import("./registry"))
          const agentInfo = yield* agents.get(ctx.agent)
          const availableTools = yield* Effect.promise(() =>
            registry.tools({
              modelID: ModelID.make(""),
              providerID: ProviderID.make(""),
              agent: agentInfo,
            }),
          )

          // Filter out disallowed tools and build PTC tool list
          const ptcToolList: PTCToolInfo[] = []
          const toolExecutors = new Map<string, ToolExecutorInfo>()

          for (const tool of availableTools) {
            if (DISALLOWED_TOOLS.has(tool.id)) continue

            const zodParams = zod(tool.parameters as Schema.Schema<unknown>)
            ptcToolList.push({
              name: tool.id,
              description: tool.description,
              parameters: parseToolParameters(zodParams),
            })

            toolExecutors.set(tool.id, {
              name: tool.id,
              execute: async (args: Record<string, unknown>, callID: string) => {
                const validatedParams = zodParams.parse(args)
                const result = await run.promise(tool.execute(validatedParams, { ...ctx, callID }))
                return result
              },
            })
          }

          const ptcContext: PTCContext = {
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            agent: ctx.agent,
          }

          const executor = new PTCExecutor(ptcToolList, toolExecutors, ctx.sessionID, ctx.messageID, session, run)
          const result = yield* Effect.promise(() => executor.execute(params.code, ptcContext))

          const output: string[] = []

          if (result.logs.length > 0) {
            output.push("=== Logs ===")
            output.push(...result.logs)
            output.push("")
          }

          if (result.toolCalls.length > 0) {
            output.push("=== Tool Calls ===")
            for (const call of result.toolCalls) {
              const status = call.error ? `ERROR: ${call.error}` : "OK"
              output.push(`- ${call.tool}(${JSON.stringify(call.args)}) [${call.duration}ms] ${status}`)
            }
            output.push("")
          }

          if (result.success) {
            output.push("=== Result ===")
            output.push(result.result !== undefined ? JSON.stringify(result.result, null, 2) : "(no return value)")
          } else {
            output.push("=== Error ===")
            output.push(result.error ?? "Unknown error")
          }

          return {
            title: `PTC Execute (${result.toolCalls.length} tool calls)`,
            output: output.join("\n"),
            metadata: {
              toolCount: ptcToolList.length,
              success: result.success,
              toolCallCount: result.toolCalls.length,
            },
          }
        }),
    }
  }),
)

export const PTCListTool = Tool.define(
  "ptc_list",
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    return {
      description: `List all available tools that can be called via the ptc tool.
Returns TypeScript-style function signatures showing the available functions and their parameters.`,
      parameters: Schema.Struct({}),
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const registry = yield* Effect.promise(() => import("./registry"))
          const agentInfo = yield* agents.get(ctx.agent)
          const availableTools = yield* Effect.promise(() =>
            registry.tools({
              modelID: ModelID.make(""),
              providerID: ProviderID.make(""),
              agent: agentInfo,
            }),
          )

          const ptcToolList: PTCToolInfo[] = []
          for (const tool of availableTools) {
            if (DISALLOWED_TOOLS.has(tool.id)) continue

            ptcToolList.push({
              name: tool.id,
              description: tool.description,
              parameters: parseToolParameters(zod(tool.parameters as Schema.Schema<unknown>)),
            })
          }

          return {
            title: "PTC Available Tools",
            output: generateFunctionSignatures(ptcToolList),
            metadata: {
              toolCount: ptcToolList.length,
            },
          }
        }),
    }
  }),
)
