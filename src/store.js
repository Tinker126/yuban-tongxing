import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
export class DataStore {
  constructor(filename, { maxRecords, maxBytes }) {
    this.filename = filename;
    this.maxRecords = maxRecords;
    this.maxBytes = maxBytes;
    this.queue = Promise.resolve();
  }
  async init() {
    await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    try { await fs.writeFile(this.filename, '[]\n', { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    await this.read(); // Fail closed on corrupt data; never reset the file silently.
  }
  async read() {
    const info = await fs.stat(this.filename);
    if (info.size > this.maxBytes) throw new Error('Data file exceeds configured limit');
    const data = JSON.parse(await fs.readFile(this.filename, 'utf8'));
    if (!Array.isArray(data) || data.some(r => !r || typeof r.sessionId !== 'string' || !Array.isArray(r.turns))) {
      throw new Error('Data file is invalid; restore a verified backup');
    }
    return data;
  }
  append(record) {
    const job = this.queue.then(async () => {
      const release = await lockfile.lock(this.filename, { realpath: false, retries: { retries: 10, minTimeout: 50, maxTimeout: 300 } });
      const temp = `${this.filename}.${randomUUID()}.tmp`;
      try {
        const records = await this.read();
        const existing = records.find(r => r.sessionId === record.sessionId);
        if (existing) {
          if (existing.contentHash !== record.contentHash) {
            const error = new Error('该会话已保存，内容不能覆盖。'); error.status = 409; throw error;
          }
          return { duplicate: true, record: existing };
        }
        if (records.length >= this.maxRecords) { const e = new Error('数据空间已满，请联系老师归档。'); e.status = 507; throw e; }
        records.push(record);
        const json = JSON.stringify(records, null, 2) + '\n';
        if (Buffer.byteLength(json) > this.maxBytes) { const e = new Error('数据空间已满，请联系老师归档。'); e.status = 507; throw e; }
        const file = await fs.open(temp, 'wx', 0o600);
        try { await file.writeFile(json); await file.sync(); } finally { await file.close(); }
        await fs.rename(temp, this.filename); // Same-directory atomic replacement.
        if (process.platform !== 'win32') {
          const dir = await fs.open(path.dirname(this.filename), 'r');
          try { await dir.sync(); } finally { await dir.close(); }
        }
        return { duplicate: false, record };
      } finally {
        await fs.unlink(temp).catch(() => {});
        await release();
      }
    });
    this.queue = job.catch(() => {});
    return job;
  }
}
