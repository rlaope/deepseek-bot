#!/usr/bin/env node
// A minimal MCP server over stdio, for the mcp scenario and the MCP docs: one tool, vault_lookup, whose answer appears
// nowhere else, so an answer that has it went through the tool. Newline-delimited JSON-RPC 2.0, as MCP's stdio
// transport is; no dependency.
//   node test/fixtures/mcp-fixture.mjs
import { createInterface } from 'node:readline'

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const TOOL = {
  name: 'vault_lookup',
  description: 'Look up a code word in the deepbot fixture vault. Returns the code stored under that word.',
  inputSchema: { type: 'object', properties: { word: { type: 'string', description: 'The code word, e.g. aurora' } }, required: ['word'] },
}
// Assembled, so the code is not in this file as written either.
const vault = { aurora: ['MCP', (23438).toString(16)].join('-') }

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
      return reply({ tools: [TOOL] })
    case 'tools/call': {
      const word = String(request.params?.arguments?.word ?? '').trim().toLowerCase()
      const code = Object.hasOwn(vault, word) ? vault[word] : undefined
      return reply({ content: [{ type: 'text', text: code !== undefined ? `The code for ${word} is ${code}.` : `No code is stored for ${word}.` }], isError: code === undefined })
    }
    default:
      return send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `no method ${request.method}` } })
  }
})
