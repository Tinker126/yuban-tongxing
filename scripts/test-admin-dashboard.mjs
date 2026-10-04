import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDatabasePool } from '../src/db.js';
import { hashPassword } from '../src/security.js';

const REAL_SESSION_DATE = '2026-09-29';
let pool, server, temporaryAdminId;
try {
  const config = loadConfig();
  pool = createDatabasePool();
  const adminResult = await pool.query(
    "SELECT id, username, name, grade, role, password_hash FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1"
  );
  const admin = adminResult.rows[0];
  assert.ok(admin, 'an administrator must be provisioned first');
  assert.equal(admin.role, 'admin');
  assert.equal(admin.grade, null);
  assert.match(admin.password_hash, /^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/);

  const practiceResult = await pool.query(
    `SELECT ps.id, ps.student_id, ps.topic, ps.grade, ps.started_at, ps.ended_at,
            ps.duration_seconds, ps.turn_count, ps.status
     FROM practice_sessions ps JOIN users u ON u.id = ps.student_id
     WHERE u.role = 'student' AND ps.topic = '问候与介绍' AND ps.grade = 3
       AND ps.turn_count = 5 AND ps.status = 'completed' AND ps.duration_seconds = 788
       AND (ps.started_at AT TIME ZONE 'Asia/Shanghai')::date = $1::date
     ORDER BY ps.started_at DESC LIMIT 1`,
    [REAL_SESSION_DATE]
  );
  const target = practiceResult.rows[0];
  assert.ok(target, 'the verified Sep 29 five-turn practice record must still exist');

  temporaryAdminId = randomUUID();
  const temporaryUsername = `admincheck_${randomBytes(5).toString('hex')}`;
  const temporaryPassword = randomBytes(24).toString('base64url');
  await pool.query(
    `INSERT INTO users (id, username, name, password_hash, grade, role)
     VALUES ($1, $2, '临时管理员测试', $3, NULL, 'admin')`,
    [temporaryAdminId, temporaryUsername, hashPassword(temporaryPassword)]
  );
  server = createApp(config, {}, { dbPool: pool }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ybtc', Origin: config.origin },
    body: JSON.stringify({ username: temporaryUsername, password: temporaryPassword })
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie') || '';
  assert.match(setCookie, /^ybtc_admin=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  const cookie = setCookie.split(';')[0];
  const me = await fetch(`${base}/api/admin/me`, { headers: { cookie } });
  assert.equal(me.status, 200);
  const meBody = await me.json();
  assert.equal(meBody.username, temporaryUsername);
  assert.equal(meBody.name, '临时管理员测试');

  const summaryResponse = await fetch(`${base}/api/admin/summary`, { headers: { cookie } });
  assert.equal(summaryResponse.status, 200);
  const summary = await summaryResponse.json();
  assert.ok(summary.studentCount >= 1);
  assert.ok(Array.isArray(summary.recentSessions));
  assert.ok(summary.recentSessions.length > 0);
  assert.ok(summary.recentSessions.every(row => row.id && row.startedAt));

  const detailResponse = await fetch(`${base}/api/admin/practice/sessions/${target.id}`, { headers: { cookie } });
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.session.id, target.id);
  assert.equal(detail.session.topic, '问候与介绍');
  assert.equal(detail.session.grade, 3);
  assert.equal(detail.session.durationSeconds, 788);
  assert.equal(detail.session.turnCount, 5);
  assert.equal(detail.session.status, 'completed');
  assert.equal(detail.turns.length, 5);
  assert.deepEqual(detail.turns.map(turn => turn.turnNumber), [1, 2, 3, 4, 5]);
  assert.ok(detail.turns.every(turn => turn.studentText.trim() && turn.aiReply.trim()));
  assert.equal(new Set(detail.turns.map(turn => turn.turnNumber)).size, 5);

  const studentDetailResponse = await fetch(`${base}/api/admin/students/${target.student_id}`, { headers: { cookie } });
  assert.equal(studentDetailResponse.status, 200);
  const studentDetail = await studentDetailResponse.json();
  assert.ok(studentDetail.sessions.some(row => row.id === target.id));

  const pageResponse = await fetch(`${base}/admin`, { headers: { cookie } });
  assert.equal(pageResponse.status, 200);
  assert.match(await pageResponse.text(), /学生学习数据/);
  console.log(`Live admin login and database verification OK: ${REAL_SESSION_DATE}, completed, 5 turns, 788 seconds, five ordered transcript/reply pairs; existing administrator preserved.`);
} catch (error) {
  console.error(`Admin dashboard verification failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  if (temporaryAdminId && pool) {
    try {
      const removed = await pool.query("DELETE FROM users WHERE id = $1 AND name = '临时管理员测试' AND role = 'admin'", [temporaryAdminId]);
      assert.equal(removed.rowCount, 1, 'temporary admin cleanup failed');
    } catch {
      console.error('Temporary admin cleanup failed; no existing accounts were changed.');
      process.exitCode = 1;
    }
  }
  await pool?.end();
}
