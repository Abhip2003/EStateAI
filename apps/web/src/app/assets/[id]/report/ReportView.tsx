'use client';

import { useRef, useState } from 'react';
import { AssetPageShell } from '../../../../components/layout/AssetPageShell';
import { Card } from '../../../../components/ui/Card';
import { Button } from '../../../../components/ui/Button';
import { LoadingState } from '../../../../components/ui/LoadingState';
import { ErrorState } from '../../../../components/ui/ErrorState';
import { EmptyState } from '../../../../components/ui/EmptyState';
import { ReportViewer } from '../../../../components/report/ReportViewer';
import { useAssetEvents } from '../../../../lib/realtime/useAssetEvents';
import { agentsApi } from '../../../../lib/api/agents';
import { SessionExpiredError } from '../../../../lib/api/client';
import type { AIMode, SecurityReportData } from '../../../../lib/types';

const MODE_LABELS: Record<AIMode, string> = {
  OFF: 'Structured only',
  SUMMARY: 'AI Summary',
  FULL_REPORT: 'AI Full Report',
};

interface ProgressEntry {
  id: string;
  type: string;
  title: string;
  at: string;
}

// Live progress: the WebSocket connection already carries every
// PLAN_*/AGENT_*/AI_REPORT_* event this run emits (Phase 10) — this
// component just filters for them while a run is in flight, no polling.
function ProgressLog({ entries }: { entries: ProgressEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <ul className="space-y-1 font-mono text-xs text-slate-500">
      {entries.map((entry) => (
        <li key={entry.id} className="flex gap-2">
          <span className="text-slate-400">{new Date(entry.at).toLocaleTimeString()}</span>
          <span>{entry.title}</span>
        </li>
      ))}
    </ul>
  );
}

export function ReportView({ assetId }: { assetId: string }) {
  const [mode, setMode] = useState<AIMode>('FULL_REPORT');
  const [report, setReport] = useState<SecurityReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressEntry[]>([]);
  const isGeneratingRef = useRef(false);

  useAssetEvents(assetId, (event) => {
    if (!isGeneratingRef.current) return;
    if (/^(PLAN_|AGENT_|AI_REPORT_)/.test(event.type)) {
      setProgress((prev) => [...prev, { id: event.id, type: event.type, title: event.title, at: event.createdAt }]);
    }
  });

  async function generate() {
    setLoading(true);
    setError(null);
    setProgress([]);
    isGeneratingRef.current = true;
    try {
      const result = await agentsApi.execute({ requestType: 'SECURITY_REPORT', assetId, aiMode: mode });
      setReport(result.data.report as SecurityReportData);
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        window.location.href = '/login';
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not generate the report.');
    } finally {
      setLoading(false);
      isGeneratingRef.current = false;
    }
  }

  return (
    <AssetPageShell assetId={assetId}>
      {() => (
        <div className="space-y-6">
          <Card title="Security Report">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label htmlFor="ai-mode" className="block text-sm font-medium text-slate-700">
                  AI mode
                </label>
                <select
                  id="ai-mode"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as AIMode)}
                  className="mt-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
                >
                  {(Object.keys(MODE_LABELS) as AIMode[]).map((value) => (
                    <option key={value} value={value}>
                      {MODE_LABELS[value]}
                    </option>
                  ))}
                </select>
              </div>
              <Button onClick={generate} disabled={loading}>
                {loading ? 'Generating…' : 'Generate Report'}
              </Button>
            </div>
          </Card>

          {loading ? (
            <Card title="Live Progress">
              <LoadingState label="Running Planner → Agents → AI…" />
              <ProgressLog entries={progress} />
            </Card>
          ) : null}
          {error ? <ErrorState message={error} onRetry={generate} /> : null}
          {!loading && !error && !report ? (
            <EmptyState
              title="No report generated yet"
              description="Choose an AI mode and click Generate Report to run the full agent pipeline for this asset."
            />
          ) : null}
          {!loading && report ? (
            <>
              <ReportViewer report={report} />
              {progress.length > 0 ? (
                <Card title="Generation Log">
                  <ProgressLog entries={progress} />
                </Card>
              ) : null}
            </>
          ) : null}
        </div>
      )}
    </AssetPageShell>
  );
}
