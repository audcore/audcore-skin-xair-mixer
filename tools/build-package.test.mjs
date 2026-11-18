import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildPackage} from './build-package.mjs';
import {readSkinArchive} from './package-archive.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(),'skin-build-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'web'));
  await writeFile(join(root,'web/index.html'),'<script type="module" src="./page.mjs"></script>');
  await writeFile(join(root,'web/page.mjs'),'export const value = 1;');
  await writeFile(join(root,'web/preview.png'),Buffer.from('89504e470d0a1a0a','hex'));
  const manifest = {id:'org.example.skin',name:'Example',version:'1.0.0',kind:'web',
    api:{major:1,minor:0},entry:'web/index.html',preview:'web/preview.png',
    window:{default:[640,480],min:[320,240],max:null},themes:['dark'],
    build:{schema:1,recipe:'web-static',platform:'windows-x86_64',toolchain:{tools:{node:process.versions.node}},
      files:['web/index.html','web/page.mjs','web/preview.png']}};
  async function save() {await writeFile(join(root,'manifest.json'),JSON.stringify(manifest));}
  await save();
  return {root,manifest,save};
}

test('standalone build is deterministic and strips build metadata',async t => {
  const {root} = await fixture(t);
  const first = await buildPackage(root), second = await buildPackage(root);
  assert.deepEqual(first.bytes,second.bytes);
  const archive = readSkinArchive(first.bytes);
  assert.equal(archive.manifest.build,undefined);
  assert.equal(archive.manifest.version,'1.0.0');
  assert.equal(archive.files.size,4);
});

test('missing dynamic modules and CSS resources reject publication',async t => {
  const {root,manifest,save} = await fixture(t);
  await writeFile(join(root,'web/page.mjs'),'await import("./missing.mjs");');
  await assert.rejects(buildPackage(root),/Missing resource/);
  await writeFile(join(root,'web/page.mjs'),'export const value=1;');
  await writeFile(join(root,'web/style.css'),'div { background: url(./missing.png); }');
  manifest.build.files.push('web/style.css'); await save();
  await assert.rejects(buildPackage(root),/Missing resource/);
});

test('rejects parent paths, duplicates and mismatched toolchains',async t => {
  const {root,manifest,save} = await fixture(t);
  manifest.build.files.push('../private.txt'); await save();
  await assert.rejects(buildPackage(root),/Invalid source path/);
  manifest.build.files.pop(); manifest.build.files.push('web/page.mjs'); await save();
  await assert.rejects(buildPackage(root),/Duplicate package file/);
  manifest.build.files.pop(); manifest.build.toolchain.tools.node='0.0.0'; await save();
  await assert.rejects(buildPackage(root),/Unsupported build recipe/);
});

test('rejects directory junctions before reading their files',async t => {
  const {root,manifest,save} = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(),'skin-outside-'));
  t.after(() => rm(outside,{recursive:true,force:true}));
  await writeFile(join(outside,'private.txt'),'private');
  await symlink(outside,join(root,'linked'),process.platform==='win32'?'junction':'dir');
  manifest.build.files.push('linked/private.txt'); await save();
  await assert.rejects(buildPackage(root),/Symlink forbidden/);
});
