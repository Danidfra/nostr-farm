import { useMemo, useState } from 'react';

import { CROP_CATALOG, CROP_IDS } from '@/farm/crops/catalog';
import type { FarmActionType } from '@/farm/slots/actions';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { DevLayout, LiveWarning, SimulationBadge } from '../DevLayout';
import {
  MALFORMED_PRESETS,
  SIM_EPOCH,
  advanceClock,
  createSimState,
  forceDry,
  forceReady,
  forceRotten,
  forceStage,
  forceWet,
  getSimSlot,
  injectMalformed,
  inspectSlot,
  runAction,
  spawnCrop,
  type MalformedPreset,
  type SimState,
} from './simulation';

const COLS = 6;
const ROWS = 3;
const CLOCK_STEPS = [10, 60, 300, 900, 3600, 86_400];

/**
 * Simulation-only test lab.
 *
 * Drives the real `src/farm` domain against a virtual clock. Nothing in this
 * page reads or writes a relay, so it is safe to hammer.
 */
export default function TestLabPage() {
  const [state, setState] = useState<SimState>(() => createSimState(COLS, ROWS));
  const [selected, setSelected] = useState({ x: 0, y: 0 });
  const [cropId, setCropId] = useState(CROP_IDS[0]);
  const [preset, setPreset] = useState<MalformedPreset>('negative growth');
  const [loadFailure, setLoadFailure] = useState<string | null>(null);

  const inspection = useMemo(() => inspectSlot(state, selected), [state, selected]);
  const crop = CROP_CATALOG[cropId];

  const act = (type: FarmActionType, id?: string) => setState((s) => runAction(s, selected, type, id));

  return (
    <DevLayout>
      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Field</CardTitle>
              <SimulationBadge />
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))` }}>
                {Array.from({ length: ROWS }).flatMap((_, y) =>
                  Array.from({ length: COLS }).map((__, x) => {
                    const cell = inspectSlot(state, { x, y });
                    const isSelected = selected.x === x && selected.y === y;
                    return (
                      <button
                        key={`${x}:${y}`}
                        type="button"
                        onClick={() => setSelected({ x, y })}
                        className={cn(
                          'flex aspect-square flex-col items-center justify-center rounded border text-[10px] leading-tight',
                          isSelected ? 'border-foreground ring-2 ring-foreground' : 'border-border',
                          cellTone(cell.view?.phase, cell.slot.content.type, cell.problem)
                        )}
                      >
                        <span className="font-mono">{x},{y}</span>
                        {cell.slot.content.type === 'plant' && (
                          <>
                            <span className="truncate px-1">{cell.slot.content.plant.cropId}</span>
                            <span>{cell.problem ? '!' : `s${cell.view?.stage ?? '?'}`}</span>
                            {cell.view && <span>{cell.view.wet ? '💧' : '·'}</span>}
                          </>
                        )}
                      </button>
                    );
                  })
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted-foreground">Selected {selected.x},{selected.y}</span>
                <Separator orientation="vertical" className="h-5" />
                <Select value={cropId} onValueChange={setCropId}>
                  <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CROP_IDS.map((id) => <SelectItem key={id} value={id}>{id}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Button size="sm" onClick={() => act('plant', cropId)}>Plant</Button>
                <Button size="sm" onClick={() => act('water')}>Water</Button>
                <Button size="sm" onClick={() => act('harvest')}>Harvest</Button>
                <Button size="sm" onClick={() => act('clear')}>Clear</Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Virtual clock — t = {state.nowSec}</CardTitle></CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {CLOCK_STEPS.map((step) => (
                <Button key={step} size="sm" variant="outline" onClick={() => setState((s) => advanceClock(s, step))}>
                  +{formatStep(step)}
                </Button>
              ))}
              <Button size="sm" variant="outline" onClick={() => setState((s) => advanceClock(s, -300))}>-5m (skew)</Button>
              <Button size="sm" variant="outline" onClick={() => setState((s) => advanceClock(s, SIM_EPOCH - s.nowSec))}>Reset clock</Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Force state (bypasses the rules)</CardTitle></CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => setState((s) => spawnCrop(s, selected, cropId))}>Spawn seed</Button>
              <Button size="sm" variant="secondary" onClick={() => setState((s) => forceWet(s, selected))}>Set wet</Button>
              <Button size="sm" variant="secondary" onClick={() => setState((s) => forceDry(s, selected))}>Set dry</Button>
              <Button size="sm" variant="secondary" onClick={() => setState((s) => forceReady(s, selected))}>Harvest-ready</Button>
              <Button size="sm" variant="secondary" onClick={() => setState((s) => forceRotten(s, selected))}>Rotten</Button>
              {crop && Array.from({ length: crop.harvestStage + 1 }).map((_, stage) => (
                <Button key={stage} size="sm" variant="outline" onClick={() => setState((s) => forceStage(s, selected, stage))}>
                  Stage {stage}
                </Button>
              ))}
              <Button size="sm" variant="destructive" onClick={() => setState(createSimState(COLS, ROWS))}>Reset all</Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Failure injection</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Select value={preset} onValueChange={(v) => setPreset(v as MalformedPreset)}>
                  <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.keys(MALFORMED_PRESETS).map((key) => <SelectItem key={key} value={key}>{key}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Button size="sm" variant="secondary" onClick={() => setState((s) => injectMalformed(s, selected, preset))}>
                  Inject malformed state
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" onClick={() => setLoadFailure('Renderpack "cozy-pixel-v1@9.9.9" is not in the pinned registry.')}>
                  Simulate renderpack load error
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setLoadFailure(null)}>Clear</Button>
              </div>
              {loadFailure && (
                <p className="rounded border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">{loadFailure}</p>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base">Computed state</CardTitle></CardHeader>
            <CardContent>
              {inspection.problem && <p className="mb-2 text-sm text-destructive">{inspection.problem}</p>}
              <Json value={{ slot: getSimSlot(state, selected.x, selected.y), view: inspection.view }} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Crop config — {cropId}</CardTitle></CardHeader>
            <CardContent><Json value={crop} /></CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Action log</CardTitle></CardHeader>
            <CardContent>
              <ol className="max-h-64 space-y-1 overflow-auto font-mono text-xs">
                {state.log.map((line, index) => <li key={`${index}-${line}`} className="text-muted-foreground">{line}</li>)}
              </ol>
            </CardContent>
          </Card>

          <LiveWarning>
            <p className="text-sm text-muted-foreground">
              No live tools are implemented yet. When they are, each one will state exactly which event it
              signs and publishes before doing anything.
            </p>
          </LiveWarning>
        </div>
      </div>
    </DevLayout>
  );
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="max-h-72 overflow-auto rounded bg-muted p-3 font-mono text-xs">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function cellTone(phase: string | undefined, type: string, problem: string | undefined): string {
  if (problem) return 'bg-destructive/20';
  if (type !== 'plant') return 'bg-muted/40';
  if (phase === 'rotten') return 'bg-stone-500/30';
  if (phase === 'ready') return 'bg-amber-400/30';
  return 'bg-emerald-500/20';
}

function formatStep(seconds: number): string {
  if (seconds >= 86_400) return `${seconds / 86_400}d`;
  if (seconds >= 3600) return `${seconds / 3600}h`;
  if (seconds >= 60) return `${seconds / 60}m`;
  return `${seconds}s`;
}
