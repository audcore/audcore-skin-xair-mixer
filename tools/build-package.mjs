// Static web-skin recipe. No project scripts or external dependencies are executed.
import {readFile, writeFile, mkdir, lstat, realpath} from 'node:fs/promises';
import {resolve, relative, isAbsolute, posix} from 'node:path';
import {pathToFileURL} from 'node:url';
import {deflateRawSync} from 'node:zlib';
import {readSkinArchive} from './package-archive.mjs';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function zipFiles(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const filename = Buffer.from(name), compressed = deflateRawSync(data, {level:6});
    const crc = crc32(data), header = Buffer.alloc(30), record = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20,4);
    header.writeUInt16LE(0x800,6); header.writeUInt16LE(8,8);
    header.writeUInt16LE(0x21,12); header.writeUInt32LE(crc,14);
    header.writeUInt32LE(compressed.length,18); header.writeUInt32LE(data.length,22);
    header.writeUInt16LE(filename.length,26);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x314,4);
    record.writeUInt16LE(20,6); record.writeUInt16LE(0x800,8); record.writeUInt16LE(8,10);
    record.writeUInt16LE(0x21,14); record.writeUInt32LE(crc,16);
    record.writeUInt32LE(compressed.length,20); record.writeUInt32LE(data.length,24);
    record.writeUInt16LE(filename.length,28); record.writeUInt32LE(0x81a40000,38);
    record.writeUInt32LE(offset,42);
    local.push(header,filename,compressed); central.push(record,filename);
    offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size,8); end.writeUInt16LE(files.size,10);
  end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}

async function sourceFile(root, name) {
  if (typeof name !== 'string' || !name || /[\\:%?#\x00-\x1f]/.test(name) ||
      name.split('/').some(part => !part || part === '.' || part === '..') || isAbsolute(name)) {
    throw Error(`Invalid source path: ${name}`);
  }
  let current = root;
  for (const part of name.split('/')) {
    current = resolve(current,part);
    if ((await lstat(current)).isSymbolicLink()) throw Error(`Symlink forbidden: ${name}`);
  }
  const resolved = await realpath(current), inside = relative(root,resolved);
  if (inside.startsWith('..') || isAbsolute(inside) || !(await lstat(current)).isFile()) throw Error(`Invalid source file: ${name}`);
  const size = (await lstat(current)).size;
  if (size > 64*1024*1024) throw Error(`Source too large: ${name}`);
  return readFile(current);
}

// Verify relative HTML/CSS/ES-module dependencies against the actual package.
export function checkReferences(files) {
  for (const [name, bytes] of files) {
    if (!/\.(?:html|css|m?js)$/.test(name)) continue;
    const source = bytes.toString('utf8');
    const refs = [];
    if (/\.html$/.test(name)) for (const match of source.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)) refs.push(match[1]);
    if (/\.css$/.test(name)) for (const match of source.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)|@import\s+["']([^"']+)["']/g)) refs.push(match[1] ?? match[2]);
    if (/\.m?js$/.test(name)) for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g)) refs.push(match[1]);
    for (const ref of refs) {
      if (/^(?:data:|#)/.test(ref)) continue;
      if (!ref.startsWith('.') && /\.m?js$/.test(name)) throw Error(`Unsupported module reference: ${name}: ${ref}`);
      if (/^(?:[a-z]+:|\/)/i.test(ref)) throw Error(`External reference: ${name}: ${ref}`);
      const target = posix.normalize(posix.join(posix.dirname(name),ref.split(/[?#]/)[0]));
      if (!files.has(target)) throw Error(`Missing resource: ${name}: ${ref}`);
    }
  }
}

export async function buildPackage(repository) {
  const root = await realpath(repository);
  const config = JSON.parse(await sourceFile(root,'manifest.json'));
  const {build, ...manifest} = config;
  if (config.kind !== 'web' || build?.schema !== 1 || build.recipe !== 'web-static' ||
      build.platform !== 'windows-x86_64' ||
      !Array.isArray(build.files) || build.files.length > 4090 ||
      build.toolchain?.tools?.node !== process.versions.node) throw Error('Unsupported build recipe or Node.js version');
  const files = new Map([['manifest.json',Buffer.from(JSON.stringify(manifest,null,2)+'\n')]]);
  let total = files.get('manifest.json').length;
  for (const name of [...build.files].sort()) {
    if (files.has(name)) throw Error(`Duplicate package file: ${name}`);
    const bytes = await sourceFile(root,name);
    total += bytes.length;
    if (total > 128*1024*1024) throw Error('Package too large');
    files.set(name,bytes);
  }
  checkReferences(files);
  const bytes = zipFiles(files);
  const checked = readSkinArchive(bytes);
  if (!files.has(manifest.preview)) throw Error('Missing preview');
  return {bytes,manifest:checked.manifest,filename:`${manifest.id}-v${manifest.version}.skin.audcore`};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [repository='.',output='dist',...extra] = process.argv.slice(2);
    if (extra.length) throw Error('Usage: node build-package.mjs <repository> <output-directory>');
    const result = await buildPackage(repository);
    await mkdir(resolve(output),{recursive:true});
    const destination = resolve(output,result.filename);
    try {
      await writeFile(destination,result.bytes,{flag:'wx'});
    } catch (error) {
      if (error.code !== 'EEXIST' || !(await readFile(destination)).equals(result.bytes)) throw error;
    }
    process.stdout.write(`${destination}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode=1; }
}
