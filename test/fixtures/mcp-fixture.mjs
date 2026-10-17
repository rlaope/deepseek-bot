#!/usr/bin/env node
// A minimal MCP server over stdio, for the mcp scenario and the MCP docs: one tool, vault_lookup, whose answer appears
// nowhere else, so an answer that has it went through the tool. Newline-delimited JSON-RPC 2.0, as MCP's stdio
// transport is; no dependency.
//   node test/fixtures/mcp-fixture.mjs
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const LOOKUP = {
  name: 'vault_lookup',
  description: 'Look up a code word in the deepbot fixture vault. Returns the code stored under that word.',
  inputSchema: { type: 'object', properties: { word: { type: 'string', description: 'The code word, e.g. aurora' } }, required: ['word'] },
}
// A tool with an effect: it writes to the file FIXTURE_STORE names (the mcp-ask scenario puts it where the agent's own
// commands cannot write), so whether it ran is a file, not what the model says.
const STORE = {
  name: 'vault_store',
  description: 'Store a code under a code word in the deepbot fixture vault.',
  inputSchema: { type: 'object', properties: { word: { type: 'string' }, code: { type: 'string' } }, required: ['word', 'code'] },
}
// Assembled, so the code is not in this file as written either.
const vault = { aurora: ['MCP', (23438).toString(16)].join('-') }
/** A code vault_store wrote, so a store that ran shows in a lookup and the model can say it worked. */
const stored = (word) => {
  if (!process.env.FIXTURE_STORE) return undefined
  try {
    return readFileSync(process.env.FIXTURE_STORE, 'utf8').split('\n').map((line) => line.split('=')).find(([w]) => w === word)?.[1]
  } catch { return undefined }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let request
  try { request = JSON.parse(line) } catch { return }
  // A notification (no id) needs no answer.
  if (request === null || typeof request !== 'object' || request.id === undefined) return
  const reply = (result) => send({ jsonrpc: '2.0', id: request.id, result })
  switch (request.method) {
    case 'initialize':
      return reply({ protocolVersion: request.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'deepbot-fixture', version: '1.0.0' } })
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: [LOOKUP, STORE] })
    case 'tools/call': {
      const word = String(request.params?.arguments?.word ?? '').trim().toLowerCase()
      if (request.params?.name === 'vault_store') {
        const store = process.env.FIXTURE_STORE
        if (!store) return reply({ content: [{ type: 'text', text: 'This vault takes no new codes.' }], isError: true })
        // Its directory made first: a store that failed for want of one read as a refused call.
        mkdirSync(dirname(store), { recursive: true })
        appendFileSync(store, `${word}=${String(request.params?.arguments?.code ?? '')}\n`)
        return reply({ content: [{ type: 'text', text: `Stored the code for ${word}.` }] })
      }
      const code = Object.hasOwn(vault, word) ? vault[word] : stored(word)
      return reply({ content: [{ type: 'text', text: code !== undefined ? `The code for ${word} is ${code}.` : `No code is stored for ${word}.` }], isError: code === undefined })
    }
    default:
      return send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `no method ${request.method}` } })
  }
})
