import { parseBinary } from './binary.js';
import { parseXmlModel } from './xml.js';

// bytes: Uint8Array of a .rbxm or .rbxmx file (format detected from content, not extension)
export function parseModel(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 8));
  if (head === '<roblox!') return parseBinary(bytes);
  return parseXmlModel(new TextDecoder().decode(bytes));
}
