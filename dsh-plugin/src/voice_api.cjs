/**
 * voice_api.js — 鱼的声音的 API（CommonJS）。
 *
 * 关键：主插件只在 /api/voice 请求到来时才 require 这个文件。
 * 这里就算写坏了/依赖挂了，也只影响语音页，主插件和记忆总览/QQ 不会挂。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const VOICE_IDS = ['stella', 'tide']
const TTS_API = 'https://api.deepseek.com/v1/tools/tts'

function dataRoot(passed) {
  return passed || process.env.MEMORY_ROOT
    || path.join(process.env.APPDATA || process.env.HOME || os.homedir(), 'dsh-memory')
}

function statePath(root) {
  return path.join(root, 'voice.json')
}

function deepseekKey(root) {
  let key = String(process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY || '').trim()
  if (key) return key
  try {
    const cred = path.join(os.homedir(), '.dsh', '.credentials.yaml')
    const txt = fs.readFileSync(cred, 'utf8')
    const m = txt.match(/^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/m)
    if (m) key = m[1].replace(/^["']|["']$/g, '').trim()
  } catch (e) { /* no credentials */ }
  if (key) return key
  try { return fs.readFileSync(path.join(root, 'voice-key.txt'), 'utf8').trim() } catch (e) { return '' }
}

function readState(root) {
  try {
    const v = JSON.parse(fs.readFileSync(statePath(root), 'utf8'))
    return {
      enabled: !!v.enabled,
      voice_id: VOICE_IDS.includes(v.voice_id) ? v.voice_id : 'stella',
    }
  } catch (e) {
    return { enabled: false, voice_id: 'stella' }
  }
}

function writeState(root, patch) {
  const cur = readState(root)
  if (patch && typeof patch.enabled === 'boolean') cur.enabled = patch.enabled
  if (patch && VOICE_IDS.includes(patch.voice_id)) cur.voice_id = patch.voice_id
  cur.updatedAt = new Date().toISOString()
  try {
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(statePath(root), JSON.stringify(cur, null, 2))
  } catch (e) { /* ignore */ }
  return cur
}

function localDay() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function heartEntries(app, day) {
  try {
    if (!app || !app.heart || typeof app.heart.entriesFor !== 'function') return []
    const rows = app.heart.entriesFor(day || localDay()) || []
    return rows.map((r) => String((r && r.text) || '').trim()).filter(Boolean)
  } catch (e) {
    return []
  }
}

async function ttsWav(text, voice, root) {
  const key = deepseekKey(root)
  if (!key) throw new Error('没读到 DEEPSEEK_API_KEY')
  const voiceId = VOICE_IDS.includes(voice) ? voice : 'stella'
  const r = await fetch(TTS_API, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: String(text || '').slice(0, 8000),
      voice_id: voiceId,
      format: 'wav',
      filter_markdown: true,
    }),
  })
  if (!r.ok) {
    let msg = ''
    try { msg = (await r.text()).slice(0, 300) } catch (e) { /* ignore */ }
    throw new Error('TTS HTTP ' + r.status + ': ' + msg)
  }
  const buf = Buffer.from(await r.arrayBuffer())
  if (!buf.length) throw new Error('TTS 返回空音频')
  return buf
}

function readBody(req, limit) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > (limit || 200000)) {
        req.destroy()
        resolve({})
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch (e) { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

function sendJson(res, code, obj) {
  if (res.headersSent) { try { res.end() } catch (e) {} return }
  const b = Buffer.from(JSON.stringify(obj), 'utf8')
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(b.length))
  res.setHeader('Cache-Control', 'no-store')
  res.end(b)
}

function sendAudio(res, buf) {
  if (res.headersSent) { try { res.end() } catch (e) {} return }
  res.statusCode = 200
  res.setHeader('Content-Type', 'audio/wav')
  res.setHeader('Content-Length', String(buf.length))
  res.setHeader('Cache-Control', 'no-store')
  res.end(buf)
}

async function handle(req, res, url, app, rootArg) {
  const root = dataRoot(rootArg)

  if (url.pathname === '/api/voice') {
    if (req.method === 'GET') {
      const st = readState(root)
      sendJson(res, 200, {
        ok: true,
        enabled: st.enabled,
        voice_id: st.voice_id,
        configured: !!deepseekKey(root),
        diaryToday: heartEntries(app).length,
      })
      return
    }
    if (req.method === 'POST') {
      const body = await readBody(req)
      const st = writeState(root, body)
      sendJson(res, 200, {
        ok: true,
        enabled: st.enabled,
        voice_id: st.voice_id,
        configured: !!deepseekKey(root),
      })
      return
    }
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }

  if (url.pathname === '/api/voice/preview' && req.method === 'POST') {
    const st = readState(root)
    if (!st.enabled) { sendJson(res, 403, { ok: false, error: '先开启语音合成' }); return }
    if (!deepseekKey(root)) { sendJson(res, 503, { ok: false, error: '没读到 DEEPSEEK_API_KEY' }); return }
    const body = await readBody(req)
    const text = String((body && body.text) || '').trim()
    if (!text) { sendJson(res, 400, { ok: false, error: '试听文本为空' }); return }
    const voice = body && VOICE_IDS.includes(body.voice_id) ? body.voice_id : st.voice_id
    try {
      const buf = await ttsWav(text, voice, root)
      sendAudio(res, buf)
    } catch (e) {
      sendJson(res, 502, { ok: false, error: e && e.message ? e.message : String(e) })
    }
    return
  }

  if (url.pathname === '/api/voice/diary' && req.method === 'POST') {
    const st = readState(root)
    if (!st.enabled) { sendJson(res, 403, { ok: false, error: '先开启语音合成' }); return }
    if (!deepseekKey(root)) { sendJson(res, 503, { ok: false, error: '没读到 DEEPSEEK_API_KEY' }); return }
    const entries = heartEntries(app)
    if (!entries.length) { sendJson(res, 404, { ok: false, error: '今天还没有写心路历程' }); return }
    try {
      const buf = await ttsWav('今天的心路历程。\n' + entries.join('\n'), st.voice_id)
      sendAudio(res, buf)
    } catch (e) {
      sendJson(res, 502, { ok: false, error: e && e.message ? e.message : String(e) })
    }
    return
  }

  sendJson(res, 404, { ok: false, error: 'not found' })
}

module.exports = { handle }
