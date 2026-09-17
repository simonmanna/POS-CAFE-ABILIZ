/** Evidence recorder: every scenario and rule outcome, written as JSON + Markdown. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import type { RuleResult, Verdict } from './oracle';
import { BUSINESS_POLICY } from './policy';

export type Priority = 'P0' | 'P1' | 'P2';
export interface ScenarioRecord {
  id: string; title: string; priority: Priority; status: Verdict;
  rules: RuleResult[]; error?: string; notes: string[]; ms: number;
}

export class Evidence {
  readonly scenarios: ScenarioRecord[] = [];
  readonly startedAt = new Date();
  constructor(readonly runId: string) {}

  async scenario(id: string, title: string, priority: Priority, fn: (r: ScenarioRecord) => Promise<void>) {
    const rec: ScenarioRecord = { id, title, priority, status: 'PASS', rules: [], notes: [], ms: 0 };
    const t0 = Date.now();
    try {
      await fn(rec);
      if (rec.status === 'PASS' && rec.rules.some((r) => r.status === 'FAIL')) rec.status = 'FAIL';
    } catch (e: any) {
      rec.status = 'FAIL';
      rec.error = String(e?.message ?? e).slice(0, 600);
    }
    rec.ms = Date.now() - t0;
    this.scenarios.push(rec);
    return rec;
  }

  write(extra: Record<string, unknown> = {}) {
    const root = path.resolve(__dirname, '../../../../var/simulations', this.runId);
    fs.mkdirSync(root, { recursive: true });
    const git = (cmd: string) => { try { return execSync(cmd, { cwd: path.resolve(__dirname, '../../../..'), encoding: 'utf8' }).trim(); } catch { return 'unknown'; } };
    const commit = { sha: git('git rev-parse HEAD'), dirtyFiles: git('git status --porcelain -- apps packages').split('\n').filter(Boolean) };
    const count = (p: Priority, s: Verdict) => this.scenarios.filter((x) => x.priority === p && x.status === s).length;
    const openP0 = this.scenarios.filter((s) => s.priority === 'P0' && s.status === 'FAIL');
    const openP1 = this.scenarios.filter((s) => s.priority === 'P1' && s.status === 'FAIL');
    const verdict = openP0.length ? 'NO-GO' : openP1.length ? 'CONDITIONAL' : 'GO';
    const report = { runId: this.runId, startedAt: this.startedAt, finishedAt: new Date(), policyVersion: BUSINESS_POLICY.version, commit, node: process.version, database: new URL(process.env.DATABASE_URL!).pathname, verdict, scenarios: this.scenarios, ...extra };
    fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(report, null, 2));
    const md: string[] = [`# Simulation ${this.runId}`, '', `Verdict (M1–M2 scope): **${verdict}**`, `Commit ${commit.sha} (+${commit.dirtyFiles.length} uncommitted files) · policy ${BUSINESS_POLICY.version}`, ''];
    for (const p of ['P0', 'P1', 'P2'] as Priority[]) md.push(`- ${p}: PASS ${count(p, 'PASS')} · FAIL ${count(p, 'FAIL')} · NOT_SUPPORTED ${count(p, 'NOT_SUPPORTED')}`);
    md.push('', '| ID | Pri | Status | Scenario | Failed rules / error |', '|---|---|---|---|---|');
    for (const s of this.scenarios) {
      const bad = s.rules.filter((r) => r.status !== 'PASS').map((r) => `${r.rule} exp ${r.expected ?? ''} got ${r.actual ?? ''} ${r.detail ?? ''}`.trim());
      md.push(`| ${s.id} | ${s.priority} | ${s.status} | ${s.title} | ${[...bad, s.error ?? '', ...s.notes].filter(Boolean).join('<br>').replace(/\|/g, '/')} |`);
    }
    fs.writeFileSync(path.join(root, 'results.md'), md.join('\n'));
    return { root, verdict };
  }
}
