// MCP server protocol check (no app needed): initialize, tools/list, and an unknown tool. Usage: node test/mcp.test.js
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const server = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp/server.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'inherit'] });
const replies = new Map();
let buf = '';
server.stdout.on('data', (d) => {
  buf += d;
  for (let nl; (nl = buf.indexOf('\n')) >= 0; buf = buf.slice(nl + 1)) { const m = JSON.parse(buf.slice(0, nl)); replies.get(m.id)?.(m); }
});
let seq = 0;
const rpc = (method, params) => new Promise((resolve) => { const id = ++seq; replies.set(id, resolve); server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
assert.equal(init.result.protocolVersion, '2025-06-18');
assert.equal(init.result.serverInfo.name, 'roblox-icon-renderer');
assert.ok(init.result.capabilities.tools && init.result.instructions);
server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const { result: { tools } } = await rpc('tools/list', {});
const names = tools.map((t) => t.name);
for (const n of ['get_status', 'list_files', 'preview', 'set_settings', 'export_images', 'export_animation', 'studio_browse', 'studio_import']) assert.ok(names.includes(n), n);
for (const t of tools) { assert.equal(t.inputSchema.type, 'object'); assert.ok(t.description.length > 10, t.name); }
const unknown = await rpc('tools/call', { name: 'nope', arguments: {} });
assert.equal(unknown.result.isError, true);
assert.equal((await rpc('bogus/method', {})).error.code, -32601);
assert.deepEqual((await rpc('ping', {})).result, {});
server.stdin.end();
console.log(`mcp ok (${tools.length} tools)`);
