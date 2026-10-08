// MCP server for AI agents (Claude Code, Codex, Claude Desktop, …): stdio, newline-delimited JSON-RPC.
// Runs under the app's own executable as Node (ELECTRON_RUN_AS_NODE=1); Settings > AI agents writes the config.
// Every tool forwards to the running app's local API (main.js, 127.0.0.1:47823), starting the app if needed.
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const PORT = +process.env.RIR_PORT || 47823; // RIR_PORT: isolated test runs
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `Roblox Icon Renderer turns Roblox models into icons, images and animations. The app starts on its own if it is closed.
Typical task: get models (studio_selection / studio_browse then studio_import, add_assets for catalog IDs, or add_file), check them with list_files,
read get_schema once, style with set_settings (camera, lighting, outline, background, text layers…), look at the result with preview
(iterate until it looks right), then export_images or export_animation to a folder. Files are referenced by the numeric id from list_files;
"files" also accepts "all" or "checked", and an omitted file means the one open in the app.`;

const FILE = { description: 'File id from list_files (omit for the file open in the app)', type: 'integer' };
const FILES = { description: 'File id, list of ids, "all" or "checked" (omit for the file open in the app)', anyOf: [{ type: 'integer' }, { type: 'array', items: { type: 'integer' } }, { type: 'string', enum: ['all', 'checked'] }] };
const ASPECT = { description: 'Width / height of the image, e.g. 1 (square, default from the app toolbar), 1.7778 (16:9), 0.5625 (9:16)', type: 'number' };
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const readOnly = { readOnlyHint: true };

// name -> [app method, description, input schema, annotations]
const TOOLS = {
  get_status: ['status', 'App version, number of open files, the open file, and whether Roblox Studio is linked.', obj(), readOnly],
  list_files: ['listFiles', 'Files open in the app: id, name, load status, warnings, and animations (for rigs).', obj(), readOnly],
  add_file: ['addFile', 'Open a .rbxm, .rbxmx or .obj file from disk as a new file.', obj({ path: { type: 'string', description: 'Absolute path' } }, ['path'])],
  add_assets: ['addAssets', 'Download Roblox catalog/asset IDs (models, accessories, gear, meshes) as new files, one per ID.', obj({ ids: { type: 'array', items: { type: 'string' }, description: 'Asset IDs or catalog links' } }, ['ids'])],
  remove_files: ['removeFiles', 'Close files in the app.', obj({ files: FILES })],
  select_file: ['selectFile', 'Show a file in the app window (what the user sees).', obj({ file: FILE })],
  get_model_tree: ['modelTree', 'Instance tree of a file with paths like "0/2/1", to disable parts or split models out.', obj({ file: FILE, path: { type: 'string', description: 'Start at this path (default: the top)' }, depth: { type: 'integer', minimum: 0, maximum: 12 } }), readOnly],
  set_parts_disabled: ['setDisabled', 'Leave instances (and everything under them) out of a file\'s render, or bring them back.', obj({ file: FILE, paths: { type: 'array', items: { type: 'string' } }, disabled: { type: 'boolean' } }, ['paths'])],
  split_models: ['splitModels', 'Make each given instance of a file its own file (its own icon), copying the file\'s settings.', obj({ file: FILE, paths: { type: 'array', items: { type: 'string' } } }, ['paths'])],
  get_schema: ['schema', 'Every render setting (sections, keys, types, ranges, options, defaults), text layer fields, lighting presets and camera views.', obj(), readOnly],
  get_settings: ['getSettings', 'Current render settings of a file.', obj({ file: FILE }), readOnly],
  set_settings: ['setSettings', 'Change render settings: { section: { key: value } } as in get_schema, "texts" (an array of text layers, replacing the current ones), and/or a camera "view" preset. Unknown keys and bad values come back as notes.',
    obj({ files: FILES, settings: { type: 'object', description: 'e.g. {"camera":{"yaw":35,"zoom":1.1},"outline":{"enabled":true,"thickness":4},"background":{"mode":"linear","color1":"#ff8800"},"texts":[{"text":"SWORD","y":0.38}]}' }, view: { type: 'string', enum: ['front', '3/4', 'side', 'back', 'top', 'tilt'] } })],
  set_background_image: ['setBackgroundImage', 'Use an image file as the background (empty path removes it).', obj({ files: FILES, path: { type: 'string' } })],
  list_profiles: ['listProfiles', 'Saved setting profiles.', obj(), readOnly],
  apply_profile: ['applyProfile', 'Apply a saved profile to files.', obj({ files: FILES, name: { type: 'string' } }, ['name'])],
  save_profile: ['saveProfile', 'Save a file\'s settings as a named profile.', obj({ file: FILE, name: { type: 'string' } }, ['name'])],
  set_animation: ['setAnimation', 'Pose a rig: an animation key/name from list_files or an animation asset ID, at a time in seconds (null animation = saved pose).', obj({ file: FILE, animation: { type: ['string', 'null'] }, time: { type: 'number', minimum: 0 } })],
  preview: ['preview', 'Render a file exactly as it would export and return the image, to check your work.', obj({ file: FILE, size: { type: 'integer', minimum: 64, maximum: 2048, description: 'Long side in px (default 512)' }, aspect: ASPECT }), readOnly],
  export_images: ['exportImages', 'Export icons (PNG, WebP or JPEG) of files into a folder, named after the files. Returns the written paths.',
    obj({ files: FILES, folder: { type: 'string', description: 'Absolute folder path' }, size: { type: 'integer', minimum: 16, maximum: 4096 }, format: { type: 'string', enum: ['png', 'webp', 'jpeg'] }, aspect: ASPECT, supersample: { type: 'integer', enum: [1, 2] } }, ['folder'])],
  export_animation: ['exportAnimation', 'Export an animation/VFX clip or a 360° turntable: PNG sequence, sprite sheet + JSON, GIF, MP4 (no transparency) or WebM (can be transparent).',
    obj({ files: FILES, folder: { type: 'string' }, format: { type: 'string', enum: ['png', 'sheet', 'gif', 'mp4', 'webm'] }, size: { type: 'integer', minimum: 16, maximum: 4096 }, fps: { type: 'integer', minimum: 1, maximum: 60 },
      start: { type: 'number', minimum: 0 }, duration: { type: 'number', minimum: 0.05, description: 'Seconds (default: the animation length or VFX timeline)' }, source: { type: 'string', enum: ['both', 'animation', 'vfx'] },
      turntable: { type: 'boolean', description: 'Camera circles the model once over the clip' }, loop: { type: 'boolean' }, aspect: ASPECT, transparent: { type: 'boolean', description: 'GIF/WebM: keep transparency (default true)' },
      backgroundColor: { type: 'string', description: '#rrggbb behind MP4, or GIF/WebM when transparent is false' } }, ['folder'])],
  studio_status: ['studioStatus', 'Whether Roblox Studio is linked through the plugin (and the plugin version).', obj(), readOnly],
  studio_selection: ['studioSelection', 'What is selected in Roblox Studio right now (id, name, class, full name).', obj(), readOnly],
  studio_browse: ['studioBrowse', 'Browse Roblox Studio\'s explorer: the top services, or the children of an instance id, a few levels deep.', obj({ id: { type: 'string', description: 'Instance id from studio_browse/studio_selection (omit for the top)' }, depth: { type: 'integer', minimum: 1, maximum: 6 } }), readOnly],
  studio_import: ['studioImport', 'Bring instances from Roblox Studio into the app, each as its own file (by ids, and/or the current selection).', obj({ ids: { type: 'array', items: { type: 'string' } }, selection: { type: 'boolean' } })],
};

// ---------- talking to the app ----------
let launching = null;
// node:http rather than fetch: long exports may take longer than fetch's 5-minute header timeout.
function post(body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/agent', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'X-RIR': '1' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Bad reply from the app')); } });
    });
    req.on('error', reject);
    req.end(data);
  });
}
// Starts the app when it isn't running: this process is the app's executable (run as Node), so launch it normally.
function launchApp() {
  launching ??= (async () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const packaged = !/^electron(\.exe)?$/i.test(path.basename(process.execPath));
    spawn(process.execPath, packaged ? [] : [ROOT], { detached: true, stdio: 'ignore', env }).unref();
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try { if ((await post({ method: 'status' })).ok) return; } catch { /* still starting */ }
    }
    throw new Error('Roblox Icon Renderer did not start; open it and try again');
  })().finally(() => { launching = null; });
  return launching;
}
async function callApp(method, params) {
  let res;
  try { res = await post({ method, params }); } catch {
    await launchApp();
    res = await post({ method, params });
  }
  if (!res.ok) throw new Error(res.error || 'The app returned an error');
  return res.result;
}

async function callTool(name, args) {
  const tool = TOOLS[name];
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true };
  try {
    const result = await callApp(tool[0], args ?? {});
    if (name === 'preview') {
      return { content: [{ type: 'image', data: result.image, mimeType: 'image/png' }, { type: 'text', text: JSON.stringify(result.file) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: e.message }], isError: true };
  }
}

// ---------- JSON-RPC over stdio ----------
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (initialized, cancelled) need no answer
  switch (method) {
    case 'initialize':
      return send({ id, result: {
        protocolVersion: PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[1],
        capabilities: { tools: {} }, serverInfo: { name: 'roblox-icon-renderer', title: 'Roblox Icon Renderer', version: VERSION }, instructions: INSTRUCTIONS,
      } });
    case 'ping': return send({ id, result: {} });
    case 'tools/list':
      return send({ id, result: { tools: Object.entries(TOOLS).map(([name, [, description, inputSchema, annotations]]) => ({ name, description, inputSchema, ...(annotations && { annotations }) })) } });
    case 'tools/call': return send({ id, result: await callTool(params?.name, params?.arguments) });
    default: return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    handle(msg).catch((e) => msg.id !== undefined && send({ id: msg.id, error: { code: -32603, message: e.message } }));
  }
});
process.stdin.on('end', () => process.exit(0));
