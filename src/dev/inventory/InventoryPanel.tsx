import { useState } from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { FarmInventoryView } from '@/hooks/farm/useFarmInventory';
import { INVENTORY_RELAYS } from '@/hooks/farm/inventory-relays';
import { farmInventoryAddress, harvestedEventIds, produceQuantity } from '@/inventory/farm-inventory';
import { abbreviate, safeNpub } from '@/inventory/issuer';
import { PRODUCE_CATALOG, PRODUCE_CROP_IDS } from '@/inventory/produce-catalog';
import type { GameInventoryFold, GameInventorySpendApplication } from '@/inventory/package';
import { cn } from '@/lib/utils';

/** What the page knows about the query itself, beside the view. */
export interface InventoryQueryState {
  isPending: boolean;
  isFetching: boolean;
  dataUpdatedAt: number;
  error: string | null;
}

export interface InventoryPanelProps {
  ownerPubkey: string;
  view: FarmInventoryView | undefined;
  query: InventoryQueryState;
  online: boolean;
  /** Injectable for tests; defaults to the wall clock. */
  nowMs?: number;
}

/**
 * Everything the read model knows about one player's `farm:main`, laid out
 * for debugging and for demonstrating the accounting.
 *
 * Presentation only. Every number is read off `view` (the same
 * `FarmInventoryView` the HUD renders) and off the `resolution` it kept; the
 * panel never fetches, never resolves and never publishes. What the live
 * controller keeps private (per-relay tail state, retry timers) is reported
 * as not exposed rather than reconstructed.
 */
export function InventoryPanel({ ownerPubkey, view, query, online, nowMs }: InventoryPanelProps) {
  const address = farmInventoryAddress(ownerPubkey);
  const npub = safeNpub(ownerPubkey);
  const resolution = view?.resolution ?? null;
  const state = resolution?.status === 'ready' ? resolution.state : null;
  const chain = resolution?.chain ?? null;

  return (
    <div className="grid gap-4 p-4 lg:grid-cols-2">
      <Section title="Inventory">
        <Rows
          rows={[
            ['Owner', npub ? abbreviate(npub, 14, 8) : abbreviate(ownerPubkey)],
            ['Address', address],
            ['Relays', INVENTORY_RELAYS.join('  ')],
          ]}
        />
      </Section>

      <Section title="Status">
        <Rows
          rows={[
            ['Resolution', <StatusPill key="status" status={view ? view.status : 'none'} />],
            [
              'Query',
              query.error
                ? `error: ${query.error}`
                : query.isPending
                  ? 'pending first authoritative read'
                  : `${query.isFetching ? 'fetching' : 'idle'} · updated ${describeAge(query.dataUpdatedAt, nowMs)}`,
            ],
            ['Browser', online ? 'online' : 'offline'],
            ['Live tails', 'not exposed by the live controller (per-relay state and retry timers stay internal)'],
          ]}
        />
        {view && view.problems.length > 0 && (
          <List title="Problems" items={view.problems} tone="bad" />
        )}
        {view && view.missingFolds.length > 0 && (
          <List
            title="Missing folds"
            items={view.missingFolds.map((ref) => `${abbreviate(ref.eventId)}${ref.relay ? ` (hint ${ref.relay})` : ''}`)}
            tone="warn"
          />
        )}
        {chain && chain.warnings.length > 0 && (
          <List title="Resolver warnings" items={chain.warnings.map((w) => `${w.code}: ${w.message}`)} tone="warn" />
        )}
      </Section>

      <Section title="Snapshot (kind:31633)">
        {view?.snapshot ? (
          <Rows
            rows={[
              ['Event id', view.snapshot.event.id],
              ['created_at', `${view.snapshot.event.created_at} · ${new Date(view.snapshot.event.created_at * 1000).toISOString()}`],
              ['Revision', view.snapshot.revision === undefined ? 'none' : String(view.snapshot.revision)],
              ['Fold head', view.snapshot.fold ? `${view.snapshot.fold.eventId}${view.snapshot.fold.relay ? ` (hint ${view.snapshot.fold.relay})` : ''}` : 'none (no spends settled yet)'],
              ['Contexts', view.snapshot.contexts.join(', ') || 'none'],
              ['Harvest markers', String(harvestedEventIds(view.snapshot).length)],
            ]}
          />
        ) : (
          <Empty>No snapshot known for this player.</Empty>
        )}
      </Section>

      <Section title="Balances">
        {view ? (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-2 font-medium">Item</th>
                <th className="py-1 pr-2 text-right font-medium">Raw</th>
                <th className="py-1 pr-2 text-right font-medium">Pending</th>
                <th className="py-1 text-right font-medium">Effective</th>
              </tr>
            </thead>
            <tbody className="font-mono tabular-nums">
              {PRODUCE_CROP_IDS.map((cropId) => {
                const produce = PRODUCE_CATALOG[cropId];
                const raw = produceQuantity(view.snapshot, produce.address);
                const effective = view.status === 'ready' ? produceQuantity(view.inventory, produce.address) : null;
                const delta = effective === null ? null : effective - raw;
                return (
                  <tr key={cropId} className="border-t border-border/60" data-testid={`balance-${cropId}`}>
                    <td className="py-1 pr-2 font-sans">{produce.name}</td>
                    <td className="py-1 pr-2 text-right">{raw}</td>
                    <td className={cn('py-1 pr-2 text-right', delta && delta < 0 && 'text-destructive')}>
                      {delta === null ? '—' : delta === 0 ? '0' : delta > 0 ? `+${delta}` : String(delta)}
                    </td>
                    <td className="py-1 text-right font-semibold">{effective === null ? 'unresolved' : effective}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty>Nothing loaded yet.</Empty>
        )}
        {view?.status === 'unresolved' && (
          <p className="mt-2 text-xs text-muted-foreground">
            Raw quantities are the last consolidated statement, not a balance: the chain they depend on could not be
            verified, so the effective column is withheld on purpose.
          </p>
        )}
      </Section>

      <Section title="Spends (kind:1416)" className="lg:col-span-2">
        {state ? (
          state.applications.length === 0 ? (
            <Empty>No spends seen against this inventory.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1 pr-3 font-medium">Status</th>
                    <th className="py-1 pr-3 font-medium">Spend id</th>
                    <th className="py-1 pr-3 font-medium">Item</th>
                    <th className="py-1 pr-3 text-right font-medium">Qty</th>
                    <th className="py-1 pr-3 font-medium">created_at</th>
                    <th className="py-1 pr-3 font-medium">Client</th>
                    <th className="py-1 font-medium">Note</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {state.applications.map((application, index) => (
                    <ApplicationRow key={index} application={application} />
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : (
          <Empty>{view?.status === 'unresolved' ? 'Spends cannot be classified while the chain is unresolved.' : 'Nothing derived yet.'}</Empty>
        )}
        {state && (
          <p className="mt-2 text-xs text-muted-foreground">
            applied {state.applied.length} · rejected {state.rejected.length} · folded {state.folded.length} · voided{' '}
            {state.voided.length} · ignored {state.ignored.length} · invalid {state.invalid.length} · duplicate ids{' '}
            {state.duplicateSpendIds.length}
          </p>
        )}
      </Section>

      <Section title="Fold chain (kind:1417)" className="lg:col-span-2">
        {chain ? (
          chain.chain.length === 0 ? (
            <Empty>{chain.headFoldId ? `Head ${abbreviate(chain.headFoldId)} referenced but not walked.` : 'The snapshot references no manifest.'}</Empty>
          ) : (
            <ol className="grid gap-2">
              {chain.chain.map((fold, index) => (
                <FoldRow key={fold.id} fold={fold} index={index} />
              ))}
            </ol>
          )
        ) : (
          <Empty>Nothing derived yet.</Empty>
        )}
        {chain && (
          <p className="mt-2 text-xs text-muted-foreground">
            settled spend ids {chain.settledSpendIds.length} (folded {chain.foldedSpendIds.length}, voided{' '}
            {chain.voidedSpendIds.length})
          </p>
        )}
      </Section>

      <Section title="Ledger (raw events)" className="lg:col-span-2">
        {view ? (
          <div className="grid gap-2 text-xs">
            <p className="text-muted-foreground">
              snapshot {view.ledger.snapshot ? 1 : 0} · spends {view.ledger.spends.size} · folds {view.ledger.folds.size}
            </p>
            {view.ledger.snapshot && <RawEvent label="snapshot" event={view.ledger.snapshot.event} />}
            {[...view.ledger.folds.values()].map((event) => (
              <RawEvent key={event.id} label="fold" event={event} />
            ))}
            {[...view.ledger.spends.values()].map((event) => (
              <RawEvent key={event.id} label="spend" event={event} />
            ))}
          </div>
        ) : (
          <Empty>Nothing loaded yet.</Empty>
        )}
      </Section>
    </div>
  );
}

function ApplicationRow({ application }: { application: GameInventorySpendApplication }) {
  if (application.status === 'invalid') {
    return (
      <tr className="border-t border-border/60">
        <td className="py-1 pr-3"><Tone tone="bad">invalid</Tone></td>
        <td className="py-1 pr-3">{abbreviate(application.event.id ?? "?")}</td>
        <td className="py-1 pr-3" colSpan={4}>—</td>
        <td className="py-1">{application.error}</td>
      </tr>
    );
  }
  const { spend } = application;
  const tone = application.status === 'applied' ? 'ok' : application.status === 'rejected' ? 'bad' : 'muted';
  const note =
    application.status === 'applied'
      ? `${application.available} → ${application.remaining}`
      : application.status === 'rejected'
        ? `${application.reason}: wanted ${application.requested}, had ${application.available}`
        : application.status === 'ignored'
          ? application.reason
          : '';
  return (
    <tr className="border-t border-border/60" data-testid={`spend-${application.status}`}>
      <td className="py-1 pr-3"><Tone tone={tone}>{application.status}</Tone></td>
      <td className="py-1 pr-3">{abbreviate(spend.id)}</td>
      <td className="py-1 pr-3">{itemLabel(spend.itemAddress)}</td>
      <td className="py-1 pr-3 text-right">{spend.quantity}</td>
      <td className="py-1 pr-3">{spend.createdAt}</td>
      <td className="py-1 pr-3 font-sans">{spend.client ?? '—'}</td>
      <td className="py-1 font-sans">{note}</td>
    </tr>
  );
}

function FoldRow({ fold, index }: { fold: GameInventoryFold; index: number }) {
  return (
    <li className="rounded border border-border/60 p-2 text-xs">
      <p className="font-mono">
        <span className="text-muted-foreground">{index === 0 ? 'head' : `#${index}`}</span> {fold.id}
        <span className="text-muted-foreground"> · created_at {fold.createdAt}</span>
      </p>
      <p className="mt-1 font-mono text-muted-foreground">
        previous: {fold.previous ? fold.previous.eventId : 'none'}
      </p>
      <p className="mt-1 font-mono">
        spends [{fold.spendIds.map((id) => abbreviate(id)).join(', ')}] · voids [{fold.voidIds.map((id) => abbreviate(id)).join(', ')}]
      </p>
    </li>
  );
}

/** Both the package's and Nostrify's event types satisfy this. */
interface RawEventLike {
  id?: string;
  kind: number;
  created_at: number;
}

function RawEvent({ label, event }: { label: string; event: RawEventLike }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded border border-border/60">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2 py-1 text-left font-mono hover:bg-muted"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="text-muted-foreground">{open ? '▾' : '▸'}</span>
        <span className="text-muted-foreground">{label}</span> {abbreviate(event.id ?? '?')}
        <span className="text-muted-foreground">kind {event.kind} · created_at {event.created_at}</span>
      </button>
      {open && <pre className="overflow-x-auto border-t border-border/60 bg-muted/50 p-2 text-[11px]">{JSON.stringify(event, null, 2)}</pre>}
    </div>
  );
}

function itemLabel(address: string): string {
  const known = PRODUCE_CROP_IDS.map((id) => PRODUCE_CATALOG[id]).find((produce) => produce.address === address);
  return known ? known.name : abbreviate(address, 14, 12);
}

function describeAge(updatedAt: number, nowMs = Date.now()): string {
  if (!updatedAt) return 'never';
  const seconds = Math.max(0, Math.round((nowMs - updatedAt) / 1000));
  return seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
}

function Section({ title, className, children }: { title: string; className?: string; children: React.ReactNode }) {
  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Rows({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid gap-1.5 text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-2">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="break-all font-mono">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function List({ title, items, tone }: { title: string; items: string[]; tone: 'warn' | 'bad' }) {
  return (
    <div className="mt-3 text-xs">
      <p className="font-medium">{title}</p>
      <ul className={cn('mt-1 list-disc pl-4 font-mono', tone === 'bad' ? 'text-destructive' : 'text-farm-harvest')}>
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function StatusPill({ status }: { status: 'ready' | 'unresolved' | 'none' }) {
  return (
    <Tone tone={status === 'ready' ? 'ok' : status === 'unresolved' ? 'bad' : 'muted'}>
      {status === 'none' ? 'no data' : status}
    </Tone>
  );
}

function Tone({ tone, children }: { tone: 'ok' | 'bad' | 'muted'; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 font-sans text-[11px] font-semibold uppercase tracking-wide',
        tone === 'ok' && 'bg-accent text-primary',
        tone === 'bad' && 'bg-destructive/15 text-destructive',
        tone === 'muted' && 'bg-muted text-muted-foreground'
      )}
    >
      {children}
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}
