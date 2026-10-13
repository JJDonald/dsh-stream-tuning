/**
 * dsh-stream-tuning — make the Web UI's live stream cheaper over a real network.
 *
 * DSH forwards every model token to the browser as its own Remote mux frame,
 * and the mux WebSocket is served without compression. Over a high-latency
 * link that is a large number of small, uncompressed JSON frames for the
 * browser to receive, parse and render. This plugin preserves the assembled
 * content of completed responses and changes no DSH file; durable stream
 * chunk boundaries and timing records do change:
 *
 *   1. `llm/stream` coalescing — consecutive text / reasoning / tool-argument
 *      deltas of the same block are merged into one chunk per `coalesceMs`
 *      window. The first delta after a quiet window passes immediately, so
 *      time-to-first-token is unchanged; structural chunks (block-start,
 *      block-end, usage, finish) flush the pending delta and pass through in
 *      order. Downstream (stream validation, the agent loop, frame revisions)
 *      only ever sees a valid, shorter chunk sequence.
 *
 *   2. permessage-deflate on `/api/remote.mux` — the gateway owns a private
 *      `ws` WebSocketServer created with `{ noServer: true }`. `ws` reads
 *      `options.perMessageDeflate` during each handshake, so enabling it on that
 *      server just before its handshake turns compression on for browsers that
 *      offer it (all current browsers do). Other WebSocket servers are untouched.
 */
import { createRequire } from 'node:module'

export const name = 'dsh-stream-tuning'

const MUX_PATH = '/api/remote.mux'
const DEFAULT_COALESCE_MS = 50
const DEFAULT_DEFLATE = { threshold: 128 }

const TIMEOUT = Symbol('timeout')

/** Whether `next` can be appended to the pending delta `pending`. */
function mergeable(pending, next) {
  if (pending.type !== next.type || pending.index !== next.index) return false
  if (next.type !== 'tool-call-delta') return true
  return pending.id === next.id && next.name === undefined
}

function merge(pending, next) {
  return next.type === 'tool-call-delta'
    ? { ...pending, argumentsDelta: pending.argumentsDelta + next.argumentsDelta }
    : { ...pending, text: pending.text + next.text }
}

function isDelta(chunk) {
  return chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta'
}

/**
 * Throttle delta chunks to at most one per `intervalMs` (leading edge
 * immediate), flushing on a timer so a stalled model never holds text back.
 * Upstream errors flush received deltas before being rethrown. Early return
 * requests upstream closure without waiting for a prefetched read; actual
 * network cancellation remains the caller's AbortSignal responsibility.
 */
export async function* coalesce(source, intervalMs, onCleanupError = () => {
  console.warn('dsh-stream-tuning: deferred upstream cleanup failed')
}) {
  const it = source[Symbol.asyncIterator]()
  let pull
  let pending
  let lastEmit = 0
  try {
    while (true) {
      let result
      try {
        pull ??= it.next()
        if (pending === undefined) {
          result = await pull
        } else {
          const wait = lastEmit + intervalMs - Date.now()
          let timer
          try {
            result = wait <= 0 ? TIMEOUT : await Promise.race([
              pull,
              new Promise(resolve => { timer = setTimeout(resolve, wait, TIMEOUT) }),
            ])
          } finally {
            clearTimeout(timer)
          }
        }
      } catch (error) {
        // The read settled with an error, so there is no outstanding pull.
        pull = undefined
        if (pending !== undefined) {
          const out = pending
          pending = undefined
          lastEmit = Date.now()
          yield out
        }
        throw error
      }
      if (result === TIMEOUT) {
        const out = pending
        pending = undefined
        lastEmit = Date.now()
        yield out
        continue
      }
      pull = undefined
      if (result.done) break
      const chunk = result.value
      if (pending !== undefined && mergeable(pending, chunk)) {
        pending = merge(pending, chunk)
        continue
      }
      if (pending !== undefined) {
        const out = pending
        pending = undefined
        lastEmit = Date.now()
        yield out
      }
      if (!isDelta(chunk)) {
        yield chunk
        continue
      }
      if (Date.now() - lastEmit >= intervalMs) {
        lastEmit = Date.now()
        yield chunk
      } else {
        pending = chunk
      }
    }
    if (pending !== undefined) yield pending
  } finally {
    const close = async () => { await it.return?.() }
    if (pull !== undefined) {
      // Async-generator return() queues behind an outstanding next(). Request
      // closure now, but do not block the consumer on that prefetched read.
      // Its eventual result is no longer consumed; deferred cleanup errors
      // are reported separately instead of becoming unhandled rejections.
      pull.catch(() => {})
      void close().catch(onCleanupError)
    } else {
      await close()
    }
  }
}

/** Enable permessage-deflate on the gateway's mux WebSocketServer. */
function installCompression(ctx, deflate) {
  // DSH is started as `node <dsh bin.js> ...`; resolve `ws` exactly as the
  // gateway does so the patched prototype is the one its server uses.
  const fromDsh = createRequire(process.argv[1])
  const gateway = fromDsh.resolve('@deepseek-ai/dsh-api-gateway/package.json')
  const { WebSocketServer } = createRequire(gateway)('ws')
  const proto = WebSocketServer.prototype
  const original = proto.handleUpgrade
  const enabled = new Set()
  proto.handleUpgrade = function (req, socket, head, cb) {
    if (this.options.noServer && this.options.perMessageDeflate === false
      && new URL(req.url ?? '/', 'http://x').pathname === MUX_PATH) {
      this.options.perMessageDeflate = { ...deflate }
      enabled.add(this)
    }
    return original.call(this, req, socket, head, cb)
  }
  ctx.effect(() => () => {
    proto.handleUpgrade = original
    for (const server of enabled) server.options.perMessageDeflate = false
  }, `${name}: mux compression`)
  ctx.logger.info(`permessage-deflate enabled for ${MUX_PATH} (threshold ${deflate.threshold} B only without server context takeover)`)
}

export function apply(ctx, config) {
  const coalesceMs = config?.coalesceMs ?? DEFAULT_COALESCE_MS
  if (coalesceMs > 0) {
    ctx.on('llm/stream', (_options, next) => coalesce(next(), coalesceMs, () => {
      ctx.logger.warn('deferred upstream stream cleanup failed after early consumer return')
    }), { global: true })
    ctx.logger.info(`coalescing model stream deltas every ${coalesceMs} ms`)
  }
  if (config?.compression !== false) {
    try {
      installCompression(ctx, { ...DEFAULT_DEFLATE, ...config?.deflate })
    } catch (error) {
      // A DSH/ws layout change must not take the Web UI down with it.
      ctx.logger.warn(`mux compression not installed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
