import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app.js';
import { unseal } from '../src/security.js';
import { getScenario, emptyScenarioProgress } from '../src/scenarios.js';

// Entire fixture is in memory: no real students, provider calls, recordings or database writes.
const origin = 'http://localhost:3000';
const token = 'i'.repeat(43);
const student = { id: '60000000-0000-4000-8000-000000000001', username: 'flow_fixture', role: 'student', grade: 3 };
const tokenHash = createHash('sha256').update(token).digest('hex');
const config = { origin, production: false, trustProxy: false, secret: 'integration-secret-'.repeat(5),
  apiKey: 'test-only-key', model: 'deepseek-flash', dailyLimit: 1000,
  stt: { provider: 'tencent', dailyLimit: 100, timeoutMs: 1000 } };

class FlowPool {
  sessions = new Map();
  turns = new Map();
  async query(sql, values = []) {
    if (sql.includes('FROM auth_sessions JOIN users')) return { rows: values[0] === tokenHash ? [student] : [] };
    if (sql.includes('INSERT INTO practice_sessions')) {
      const [id, studentId, topic, grade, sceneId, sceneTitle, progress] = values;
      this.sessions.set(id, { id, student_id: studentId, topic, grade, scene_id: sceneId,
        scene_title: sceneTitle, scenario_progress: JSON.parse(progress), scenario_completed_at: null,
        status: 'active', turn_count: 0 });
      return { rows: [] };
    }
    if (sql.includes('FROM practice_sessions') && sql.includes('id = $1 AND student_id = $2')) {
      const row = this.sessions.get(values[0]);
      const match = row && row.student_id === values[1] &&
        (!sql.includes('grade = $3') || (row.grade === values[2] && row.topic === values[3]));
      return { rows: match ? [{ ...row }] : [] };
    }
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.includes('FROM practice_turns WHERE session_id = $1 AND turn_number = $2')) {
      const row = this.turns.get(`${values[0]}:${values[1]}`);
      return { rows: row ? [row] : [] };
    }
    if (sql.includes('INSERT INTO practice_turns')) {
      const [id, sessionId, turnNumber, text, reply, feedback, inputMode, confidence] = values;
      this.turns.set(`${sessionId}:${turnNumber}`, { id, session_id: sessionId, turn_number: turnNumber,
        student_text: text, ai_reply: reply, feedback: JSON.parse(feedback), input_mode: inputMode, recognition_confidence: confidence });
      return { rows: [] };
    }
    if (sql.includes('UPDATE practice_sessions SET turn_count')) {
      this.sessions.get(values[0]).turn_count = values[1]; return { rows: [] };
    }
    if (sql.includes('SET scenario_progress')) {
      this.sessions.get(values[0]).scenario_progress = JSON.parse(values[1]); return { rows: [] };
    }
    throw new Error('Unexpected in-memory flow query');
  }
  async connect() { return { query: this.query.bind(this), release() {} }; }
}

for (const scenarioMode of [false, true]) {
  test(`${scenarioMode ? 'scenario' : 'free'} raw STT result reaches unchanged chat API and authenticated idempotent practice receipt save`, async t => {
    const pool = new FlowPool();
    const scene = scenarioMode ? getScenario('school-talk', 3) : null;
    const topic = scene?.title || '问候与介绍';
    const sttTexts = ['The first integration fixture.', 'The second integration fixture.'];
    let sttCalls = 0;
    const modelBodies = [];
    const app = createApp(config, {}, {
      dbPool: pool,
      speechOptions: {
        readiness: async () => true,
        transcoder: async ({ audio }) => {
          assert.deepEqual([...audio], [0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
          return { audio: Buffer.alloc(32000, 1), durationSeconds: 1 };
        },
        provider: { async transcribeAudio({ language, mimeType }) {
          assert.equal(language, 'en'); assert.equal(mimeType, 'audio/pcm');
          return { text: sttTexts[sttCalls++], provider: 'tencent', confidence: null };
        } }
      },
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://api.deepseek.com/chat/completions');
        modelBodies.push(JSON.parse(options.body));
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
          reply: 'This is an integration fixture reply.',
          comment: { highlight: '测试反馈亮点', suggestion: '测试反馈建议' },
          ...(scene ? { progress: emptyScenarioProgress(scene) } : {})
        }) } }] });
      }
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { origin, 'x-requested-with': 'ybtc', cookie: `ybtc_student=${token}` };
    const post = (url, body) => fetch(base + url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const raw = (override = {}) => fetch(`${base}/api/speech/transcribe`, {
      method: 'POST', headers: { ...headers, 'content-type': 'audio/webm;codecs=opus', ...override },
      body: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])
    });

    // The app's existing CSRF boundary also protects the one raw-audio route.
    assert.equal((await raw({ origin: 'https://other.example' })).status, 403);
    assert.equal((await raw({ 'x-requested-with': '' })).status, 403);
    assert.equal((await raw({ cookie: '' })).status, 401);
    assert.equal(sttCalls, 0);
    const created = await post('/api/practice/sessions', { grade: 3, topic, consent: true, ...(scene ? { sceneId: scene.id } : {}) });
    assert.equal(created.status, 201);
    const { sessionId: practiceSessionId } = await created.json();
    const start = await post(scene ? `/api/scenarios/${scene.id}/start` : '/api/startSession',
      { grade: 3, topic, consent: true, practiceSessionId });
    assert.equal(start.status, 200);
    const { sessionToken } = await start.json();
    const history = [];

    for (let index = 0; index < 2; index++) {
      const transcription = await raw();
      assert.equal(transcription.status, 200);
      const { text, confidence } = await transcription.json();
      const reply = await post(scene ? '/api/scenarios/chat' : '/api/chat', {
        sessionToken, history, grade: 3, topic, text, confidence, inputMode: 'speech'
      });
      assert.equal(reply.status, 200);
      const result = await reply.json();
      assert.equal(modelBodies.at(-1).messages.at(-1).content, sttTexts[index]);
      const receipt = unseal(result.receipt, config.secret);
      assert.equal(receipt.student, sttTexts[index]);
      assert.equal(receipt.reply, result.reply);
      assert.equal(receipt.studentId, student.id);
      assert.equal(receipt.practiceSessionId, practiceSessionId);
      assert.equal(receipt.inputMode, 'speech');
      assert.equal(receipt.confidence, null);
      const saved = await post(`/api/practice/sessions/${practiceSessionId}/turns`, { turnNumber: index + 1, receipt: result.receipt });
      assert.equal(saved.status, 201);
      assert.equal((await post(`/api/practice/sessions/${practiceSessionId}/turns`, { turnNumber: index + 1, receipt: result.receipt })).status, 200);
      assert.equal(pool.turns.get(`${practiceSessionId}:${index + 1}`).student_text, sttTexts[index]);
      history.push(result.receipt);
    }
    assert.equal(pool.turns.size, 2);
    assert.equal(pool.sessions.get(practiceSessionId).turn_count, 2);
    assert.equal(modelBodies[1].messages[2].content, sttTexts[0]);
  });
}
