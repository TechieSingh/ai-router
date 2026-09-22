import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Database, SqlJsStatic } from 'sql.js';
import type { Event, Message, Thread } from './types';

export class Store {
  private db: Database;
  private lock?: string;
  constructor(SQL: SqlJsStatic, private filename?: string) {
    if (filename) {
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      this.lock = `${filename}.lock`;
      if (fs.existsSync(this.lock)) {
        const pid = Number(fs.readFileSync(this.lock, 'utf8'));
        let alive = true;
        try { process.kill(pid, 0); } catch (e: any) { if (e.code === 'ESRCH') alive = false; }
        if (alive) throw new Error('This project history is open in another VS Code window. Close that window first.');
        fs.unlinkSync(this.lock);
      }
      fs.writeFileSync(this.lock, String(process.pid), { flag: 'wx' });
    }
    try {
      this.db = new SQL.Database(filename && fs.existsSync(filename) ? fs.readFileSync(filename) : undefined);
      this.db.run(`CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, thread TEXT NOT NULL, run TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_thread ON events(thread,id);
        CREATE TABLE IF NOT EXISTS memory(project TEXT PRIMARY KEY, content TEXT NOT NULL, updated TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS costs(id TEXT PRIMARY KEY, run TEXT NOT NULL, day TEXT NOT NULL, amount REAL NOT NULL);`);
      this.recover();
      this.flush();
    } catch (e) { if (this.lock) fs.rmSync(this.lock, { force: true }); throw e; }
  }
  private rows(sql: string, args: any[] = []): any[] {
    const stmt = this.db.prepare(sql);
    try { stmt.bind(args); const rows = []; while (stmt.step()) rows.push(stmt.getAsObject()); return rows; }
    finally { stmt.free(); }
  }
  private flush() {
    if (!this.filename) return;
    const temp = `${this.filename}.tmp`;
    const handle = fs.openSync(temp, 'w');
    try { fs.writeFileSync(handle, this.db.export()); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    fs.renameSync(temp, this.filename);
  }
  createThread(project: string, title = 'New conversation'): Thread {
    const thread = { id: randomUUID(), project, title, created: new Date().toISOString() };
    this.db.run('INSERT INTO threads VALUES(?,?,?,?)', [thread.id, project, title, thread.created]); this.flush(); return thread;
  }
  threads(project: string): Thread[] { return this.rows('SELECT * FROM threads WHERE project=? ORDER BY created DESC', [project]); }
  thread(id: string): Thread {
    const result = this.rows('SELECT * FROM threads WHERE id=?', [id])[0];
    if (!result) throw new Error('Conversation not found'); return result;
  }
  rename(id: string, title: string) { this.db.run('UPDATE threads SET title=? WHERE id=?', [title.slice(0, 80), id]); this.flush(); }
  append(thread: string, run: string, kind: string, payload: unknown): Event {
    const created = new Date().toISOString();
    this.db.run('INSERT INTO events(thread,run,kind,payload,created) VALUES(?,?,?,?,?)', [thread, run, kind, JSON.stringify(payload), created]);
    const id = Number(this.rows('SELECT last_insert_rowid() AS id')[0].id); this.flush();
    return { id, thread, run, kind, payload, created };
  }
  events(thread: string): Event[] { return this.rows('SELECT * FROM events WHERE thread=? ORDER BY id', [thread]).map(e => ({ ...e, payload: JSON.parse(e.payload) })); }
  messages(thread: string): Message[] { return this.events(thread).filter(e => e.kind === 'message').map(e => e.payload); }
  getMemory(project: string): string { return this.rows('SELECT content FROM memory WHERE project=?', [project])[0]?.content ?? ''; }
  setMemory(project: string, content: string) {
    if (content.length > 12000) throw new Error('Project memory must be at most 12,000 characters. Keep durable facts concise.');
    this.db.run('INSERT OR REPLACE INTO memory VALUES(?,?,?)', [project, content, new Date().toISOString()]); this.flush();
  }
  search(thread: string, query: string): Event[] {
    return this.events(thread).filter(e => e.kind === 'message' && JSON.stringify(e.payload).toLowerCase().includes(query.toLowerCase())).slice(-12);
  }
  spent(run?: string): number {
    return Number(this.rows(run ? 'SELECT COALESCE(SUM(amount),0) AS total FROM costs WHERE run=?' : 'SELECT COALESCE(SUM(amount),0) AS total FROM costs WHERE day=?', [run ?? new Date().toISOString().slice(0, 10)])[0].total);
  }
  reserve(run: string, amount: number): string {
    const id = randomUUID(); this.db.run('INSERT INTO costs VALUES(?,?,?,?)', [id, run, new Date().toISOString().slice(0, 10), amount]); this.flush(); return id;
  }
  settle(id: string, amount: number) { this.db.run('UPDATE costs SET amount=? WHERE id=?', [amount, id]); this.flush(); }
  private recover() {
    const openRuns = this.rows("SELECT thread,run FROM events WHERE kind='run_started' AND run NOT IN (SELECT run FROM events WHERE kind='run_finished')");
    for (const { thread, run } of openRuns) {
      this.closePendingTools(thread, run, 'Interrupted before a durable result. Effects may be unknown. Inspect the workspace before retrying.');
      this.append(thread, run, 'status', { text: 'Previous run was interrupted. History was recovered; no tools were replayed.' });
      this.append(thread, run, 'run_finished', { status: 'interrupted' });
    }
  }
  closePendingTools(thread: string, run: string, reason: string) {
    const events = this.events(thread).filter(e => e.run === run && e.kind === 'message');
    const results = new Set(events.filter(e => e.payload.role === 'tool').map(e => e.payload.tool_call_id));
    for (const event of events) for (const call of event.payload.tool_calls ?? []) {
      if (!results.has(call.id)) this.append(thread, run, 'message', { role: 'tool', tool_call_id: call.id, content: reason });
    }
  }
  close() { this.flush(); this.db.close(); if (this.lock) fs.rmSync(this.lock, { force: true }); }
}
