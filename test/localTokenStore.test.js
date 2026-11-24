import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalTokenStore } from '../src/local/localTokenStore.js';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokstore-'));
  return path.join(dir, 'tokens.json');
}

test('get on a missing file is undefined', () => {
  assert.equal(new LocalTokenStore(tmpFile()).get('1.2.3.4'), undefined);
});

test('set then get returns the token', () => {
  const s = new LocalTokenStore(tmpFile());
  s.set('1.2.3.4', 'abc');
  assert.equal(s.get('1.2.3.4'), 'abc');
});

test('a second instance on the same file reads it', () => {
  const f = tmpFile();
  new LocalTokenStore(f).set('1.2.3.4', 'abc');
  assert.equal(new LocalTokenStore(f).get('1.2.3.4'), 'abc');
  assert.equal(fs.existsSync(`${f}.tmp`), false);
});

test('two IPs are kept separately', () => {
  const s = new LocalTokenStore(tmpFile());
  s.set('1.1.1.1', 'a');
  s.set('2.2.2.2', 'b');
  assert.equal(s.get('1.1.1.1'), 'a');
  assert.equal(s.get('2.2.2.2'), 'b');
});

test('a corrupt file behaves as empty and is overwritten by the next set', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{not json');
  const s = new LocalTokenStore(f);
  assert.equal(s.get('1.1.1.1'), undefined);
  s.set('1.1.1.1', 'a');
  assert.equal(new LocalTokenStore(f).get('1.1.1.1'), 'a');
});

test('the token file is written with mode 0600', () => {
  const f = tmpFile();
  new LocalTokenStore(f).set('1.2.3.4', 'abc');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});
