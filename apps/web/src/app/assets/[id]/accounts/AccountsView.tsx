'use client';

import { useCallback, useState } from 'react';
import { AssetPageShell } from '@/components/layout/AssetPageShell';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { FormField, Input } from '@/components/ui/Input';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusBadge } from '@/components/ui/RiskBadge';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAssetEvents } from '@/lib/realtime/useAssetEvents';
import { accountsApi } from '@/lib/api/accounts';
import { Plug } from 'lucide-react';

function ConnectAccountForm({ assetId, onConnected }: { assetId: string; onConnected: () => void }) {
  const [credential, setCredential] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await accountsApi.connect({
        assetId,
        provider: 'github',
        credential: credential || undefined,
        displayName: displayName || undefined,
      });
      setCredential('');
      setDisplayName('');
      onConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect account.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <FormField label="Provider">
        <Input value="github" disabled />
      </FormField>
      <FormField label="Access token / credential" htmlFor="credential">
        <Input id="credential" type="password" value={credential} onChange={(e) => setCredential(e.target.value)} />
      </FormField>
      <FormField label="Display name (optional)" htmlFor="display-name">
        <Input id="display-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </FormField>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" disabled={submitting}>
        {submitting ? 'Connecting…' : 'Connect GitHub Account'}
      </Button>
    </form>
  );
}

function AccountsSection({ assetId }: { assetId: string }) {
  const [showForm, setShowForm] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [disconnectId, setDisconnectId] = useState<string | null>(null);
  const query = useApiQuery(
    useCallback(() => accountsApi.list({ assetId, page: 1, limit: 20 }), [assetId]),
    [assetId],
  );

  useAssetEvents(assetId, (event) => {
    if (event.type.startsWith('JOB_')) query.refetch();
  });

  async function runAction(action: () => Promise<unknown>) {
    setActionError(null);
    try {
      await action();
      query.refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed.');
    }
  }

  return (
    <Card
      title="Connected Accounts"
      action={
        <Button variant="secondary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Cancel' : 'Connect Account'}
        </Button>
      }
    >
      {showForm ? (
        <div className="mb-4 border-b border-border pb-4">
          <ConnectAccountForm
            assetId={assetId}
            onConnected={() => {
              setShowForm(false);
              query.refetch();
            }}
          />
        </div>
      ) : null}

      {actionError ? <p className="mb-3 text-sm text-destructive">{actionError}</p> : null}

      <QueryBoundary
        query={query}
        loadingLabel="Loading accounts…"
        isEmpty={(data) => data.items.length === 0}
        emptyState={
          <EmptyState
            icon={Plug}
            title="No accounts connected"
            description="Connect a GitHub account to start discovery."
          />
        }
      >
        {(page) => (
          <ul className="divide-y divide-border">
            {page.items.map((account) => (
              <li key={account.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div>
                  <p className="text-sm font-medium">
                    {account.provider} — {account.displayName ?? account.username ?? account.externalId}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {account.connectionStatus} · last synced{' '}
                    {account.lastSyncedAt ? new Date(account.lastSyncedAt).toLocaleString() : 'never'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={account.connectionStatus} />
                  <Button variant="secondary" size="sm" onClick={() => runAction(() => accountsApi.sync(account.id))}>
                    Sync
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => runAction(() => accountsApi.discover(account.id))}
                  >
                    Discover
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => setDisconnectId(account.id)}>
                    Disconnect
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <ConfirmationDialog
        open={disconnectId !== null}
        onOpenChange={(open) => !open && setDisconnectId(null)}
        title="Disconnect account?"
        description="This soft-disconnects the account — it can be reconnected later."
        confirmLabel="Disconnect"
        variant="danger"
        onConfirm={() => {
          if (disconnectId) runAction(() => accountsApi.disconnect(disconnectId));
          setDisconnectId(null);
        }}
      />
    </Card>
  );
}

export function AccountsView({ assetId }: { assetId: string }) {
  return <AssetPageShell assetId={assetId}>{() => <AccountsSection assetId={assetId} />}</AssetPageShell>;
}
