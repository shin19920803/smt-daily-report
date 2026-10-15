import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const helper = new URL('../scripts/with-supabase-db.sh', import.meta.url).pathname;
function run(mode, interactive = false) {
    const dir = mkdtempSync(join(tmpdir(), 'production-credential-test-'));
    const log = join(dir, 'events');
    const secret = 'fixture:password\\with$characters';
    writeFileSync(join(dir, 'security'), `#!/usr/bin/env node
const fs = require('node:fs');
const action = process.argv[2];
fs.appendFileSync(process.env.DB_TEST_LOG, JSON.stringify({action})+'\\n');
const state = process.env.DB_TEST_LOG+'.saved';
if (action === 'add-generic-password') {
    if (process.argv.at(-1) !== '-w' || process.argv.includes(process.env.DB_TEST_SECRET)) process.exit(92);
    fs.writeFileSync(state,'saved'); process.exit(0);
}
if (action === 'delete-generic-password') { fs.rmSync(state,{force:true}); process.exit(0); }
if (action !== 'find-generic-password') process.exit(90);
if (process.env.DB_TEST_MODE.startsWith('setup') && !fs.existsSync(state)) process.exit(44);
if (process.env.DB_TEST_MODE === 'missing') process.exit(44);
if (process.env.DB_TEST_MODE === 'locked') process.exit(36);
process.stdout.write(process.env.DB_TEST_SECRET);
`, { mode: 0o700 });
    writeFileSync(join(dir, 'psql'), `#!/usr/bin/env node
const fs = require('node:fs');
const filename = process.env.PGPASSFILE;
const actual = fs.readFileSync(filename, 'utf8');
const escaped = process.env.DB_TEST_SECRET.replaceAll('\\\\','\\\\\\\\').replaceAll(':','\\\\:');
const expected = ['aws-1-ap-south-1.pooler.supabase.com','5432','postgres','postgres.ccwkcwriebxipndxkvyr',escaped].join(':')+'\\n';
if (actual !== expected || (fs.statSync(filename).mode & 0o777) !== 0o600 || process.env.PGPASSWORD) process.exit(91);
const verify = process.argv.some(value=>value.startsWith('--command='));
fs.appendFileSync(process.env.DB_TEST_LOG, JSON.stringify({action:verify?'verify':'operation', filename})+'\\n');
if (verify && process.env.DB_TEST_MODE.endsWith('invalid')) {
    console.error('psql: FATAL: password authentication failed for user "postgres"'); process.exit(2);
}
if (verify && process.env.DB_TEST_MODE.endsWith('network')) {
    console.error('psql: could not connect: timeout'); process.exit(2);
}
if (verify) console.log('t');
`, { mode: 0o700 });
    try {
        const command = interactive ? '/usr/bin/python3' : 'bash';
        const terminal = `import os,pty,sys
pid,fd=pty.fork()
if pid==0: os.execvp('bash',['bash']+sys.argv[1:])
while True:
    try: output=os.read(fd,4096)
    except OSError: break
    if not output: break
    sys.stdout.buffer.write(output)
os.close(fd)
_,status=os.waitpid(pid,0)
sys.exit(os.waitstatus_to_exitcode(status))
`;
        const args = interactive ? ['-c',terminal,helper,'psql','--file=fixture.sql'] : [helper,'psql','--file=fixture.sql'];
        const result = spawnSync(command, args, {
            encoding: 'utf8', input: '', timeout: 10000, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`,
                DB_TEST_MODE: mode, DB_TEST_LOG: log, DB_TEST_SECRET: secret,
                PGPASSWORD: 'must-not-be-used' }
        });
        const events = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
        assert.ok(!`${result.stdout}${result.stderr}`.includes(secret), '憑證不可出現在輸出');
        for (const event of events.filter(value=>value.filename)) assert.equal(existsSync(event.filename), false, '短期 pgpass 必須清除');
        return { ...result, events };
    } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('已保存的專案憑證先驗證才執行；特殊字元不洩漏且短期檔案清除', () => {
    const result = run('valid');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.events.map(value=>value.action), ['find-generic-password','verify','operation']);
});
test('密碼錯誤時阻止資料庫修改，非互動執行不再反覆要求輸入', () => {
    const result = run('invalid');
    assert.equal(result.status, 3);
    assert.ok(!result.events.some(value=>value.action==='operation'));
    assert.match(result.stderr, /沒有有效的專案憑證/);
});
test('網路失敗時保留鑰匙圈憑證並阻止修改', () => {
    const result = run('network');
    assert.equal(result.status, 3);
    assert.deepEqual(result.events.map(value=>value.action), ['find-generic-password','verify']);
    assert.match(result.stderr, /保留鑰匙圈憑證/);
});
test('沒有憑證或鑰匙圈鎖住時，不啟動 SQL 操作、不寫入新憑證', () => {
    for (const mode of ['missing','locked']) {
        const result = run(mode);
        assert.equal(result.status, 3);
        assert.deepEqual(result.events.map(value=>value.action), ['find-generic-password']);
    }
});
test('首次設定經原生提示保存，驗證成功後才執行操作', () => {
    const result = run('setup_valid', true);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.events.map(value=>value.action), ['find-generic-password','add-generic-password','find-generic-password','verify','operation']);
});
test('首次密碼錯誤會移除新憑證，網路失敗則保留供下次驗證', () => {
    for (const mode of ['setup_invalid','setup_network']) {
        const result = run(mode, true);
        assert.ok(!result.events.some(value=>value.action==='operation'));
        assert.equal(result.events.some(value=>value.action==='delete-generic-password'), mode==='setup_invalid');
    }
});
