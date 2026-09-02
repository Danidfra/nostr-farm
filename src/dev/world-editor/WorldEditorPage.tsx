import { useMemo, useState } from 'react';

import { MAP_DEFINITIONS, DEFAULT_MAP_DEFINITION_ID } from '@/world/definitions/registry';
import { parseMapDefinition, serializeMapDefinition, zoneKinds, type MapDefinition, type MapZone } from '@/world/definitions/schema';
import { computeGrid } from '@/world/renderer/grid';
import { resolveRenderpack } from '@/world/renderpack/registry';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { DevLayout, SimulationBadge } from '../DevLayout';

/**
 * World editor — foundation.
 *
 * The current farm renders a baked background rather than a tileset, so this
 * edits *regions and objects over a background*: plant area, grid, spawn point
 * and zones. It produces exactly the source-controlled `MapDefinition` shape,
 * which is then pasted into `src/world/definitions/maps/`.
 *
 * Deliberately deferred: tile painting, collision brushes, warp wiring between
 * maps, object sprite browsing, and publishing definitions to a relay.
 */
export default function WorldEditorPage() {
  const [draft, setDraft] = useState<MapDefinition>(() => structuredClone(MAP_DEFINITIONS[DEFAULT_MAP_DEFINITION_ID]));
  const [importText, setImportText] = useState('');
  const [importIssues, setImportIssues] = useState<string[]>([]);

  const validation = useMemo(() => parseMapDefinition(draft), [draft]);
  const grid = useMemo(() => computeGrid(draft), [draft]);
  const release = resolveRenderpack(draft.renderpack);
  const backgroundUrl = release ? `${release.baseUrl}/${draft.background}` : undefined;

  const patch = (changes: Partial<MapDefinition>) => setDraft((d) => ({ ...d, ...changes }));

  const addZone = () => {
    const id = `zone-${draft.zones.length + 1}`;
    const zone: MapZone = { id, kind: 'interaction', rect: { x: 0, y: 0, w: draft.tileSize, h: draft.tileSize } };
    patch({ zones: [...draft.zones, zone] });
  };

  const updateZone = (index: number, changes: Partial<MapZone>) =>
    patch({ zones: draft.zones.map((z, i) => (i === index ? { ...z, ...changes } : z)) });

  const removeZone = (index: number) => patch({ zones: draft.zones.filter((_, i) => i !== index) });

  const doImport = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(importText);
    } catch (error) {
      setImportIssues([error instanceof Error ? error.message : 'Invalid JSON']);
      return;
    }
    const result = parseMapDefinition(parsed);
    if (!result.definition) {
      setImportIssues(result.issues);
      return;
    }
    setDraft(result.definition);
    setImportIssues(result.ok ? [] : result.issues);
  };

  return (
    <DevLayout>
      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Preview — {draft.name}</CardTitle>
            <SimulationBadge />
          </CardHeader>
          <CardContent>
            <div
              className="relative w-full overflow-hidden rounded border bg-muted"
              style={{ aspectRatio: `${draft.backgroundSize.w} / ${draft.backgroundSize.h}` }}
            >
              {backgroundUrl ? (
                <img src={backgroundUrl} alt={draft.name} className="absolute inset-0 h-full w-full" style={{ imageRendering: 'pixelated' }} />
              ) : (
                <p className="absolute inset-0 flex items-center justify-center text-sm text-destructive">
                  Renderpack {draft.renderpack.id}@{draft.renderpack.version} is not pinned in the registry.
                </p>
              )}

              <Overlay definition={draft} rect={draft.plantArea} className="border-2 border-sky-400/80 bg-sky-400/10" label="plant area" />

              {grid.cells.map((cell) => (
                <Overlay
                  key={`${cell.col}:${cell.row}`}
                  definition={draft}
                  rect={{ x: cell.x, y: cell.y, w: cell.width, h: cell.height }}
                  className="border border-white/40"
                />
              ))}

              {draft.zones.map((zone) => (
                <Overlay
                  key={zone.id}
                  definition={draft}
                  rect={zone.rect}
                  className="border-2 border-fuchsia-400/80 bg-fuchsia-400/10"
                  label={`${zone.kind}: ${zone.id}`}
                />
              ))}

              {draft.spawn && (
                <Overlay
                  definition={draft}
                  rect={{ x: draft.spawn.x - 8, y: draft.spawn.y - 8, w: 16, h: 16 }}
                  className="rounded-full border-2 border-amber-400 bg-amber-400/40"
                  label="spawn"
                />
              )}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base">Map</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Field label="Load official map">
                <Select
                  value={Object.keys(MAP_DEFINITIONS).includes(draft.id) ? draft.id : ''}
                  onValueChange={(id) => setDraft(structuredClone(MAP_DEFINITIONS[id]))}
                >
                  <SelectTrigger><SelectValue placeholder="custom draft" /></SelectTrigger>
                  <SelectContent>
                    {Object.keys(MAP_DEFINITIONS).map((id) => <SelectItem key={id} value={id}>{id}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="id"><Input value={draft.id} onChange={(e) => patch({ id: e.target.value })} /></Field>
              <Field label="name"><Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} /></Field>
              <Field label="revision">
                <NumberInput value={draft.revision} onChange={(revision) => patch({ revision })} />
              </Field>
              <Field label="background (renderpack path)">
                <Input value={draft.background} onChange={(e) => patch({ background: e.target.value })} />
              </Field>
              <Field label="tileSize">
                <NumberInput value={draft.tileSize} onChange={(tileSize) => patch({ tileSize })} />
              </Field>

              <Group label="plant area">
                {(['x', 'y', 'w', 'h'] as const).map((key) => (
                  <NumberInput
                    key={key}
                    aria-label={`plantArea.${key}`}
                    value={draft.plantArea[key]}
                    onChange={(value) => patch({ plantArea: { ...draft.plantArea, [key]: value } })}
                  />
                ))}
              </Group>

              <Group label="grid cols / rows">
                <NumberInput aria-label="grid.cols" value={draft.grid.cols} onChange={(cols) => patch({ grid: { ...draft.grid, cols } })} />
                <NumberInput aria-label="grid.rows" value={draft.grid.rows} onChange={(rows) => patch({ grid: { ...draft.grid, rows } })} />
                <Select value={draft.grid.align} onValueChange={(align) => patch({ grid: { ...draft.grid, align: align as 'center' | 'top-left' } })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="center">center</SelectItem>
                    <SelectItem value="top-left">top-left</SelectItem>
                  </SelectContent>
                </Select>
              </Group>

              <Group label="spawn x / y">
                <NumberInput aria-label="spawn.x" value={draft.spawn?.x ?? 0} onChange={(x) => patch({ spawn: { x, y: draft.spawn?.y ?? 0 } })} />
                <NumberInput aria-label="spawn.y" value={draft.spawn?.y ?? 0} onChange={(y) => patch({ spawn: { x: draft.spawn?.x ?? 0, y } })} />
              </Group>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Zones</CardTitle>
              <Button size="sm" variant="outline" onClick={addZone}>Add zone</Button>
            </CardHeader>
            <CardContent className="space-y-3">
              {draft.zones.length === 0 && <p className="text-sm text-muted-foreground">No zones yet.</p>}
              {draft.zones.map((zone, index) => (
                <div key={index} className="space-y-2 rounded border p-2">
                  <div className="flex gap-2">
                    <Input value={zone.id} onChange={(e) => updateZone(index, { id: e.target.value })} />
                    <Select value={zone.kind} onValueChange={(kind) => updateZone(index, { kind: kind as MapZone['kind'] })}>
                      <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {zoneKinds.map((kind) => <SelectItem key={kind} value={kind}>{kind}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Button size="sm" variant="ghost" onClick={() => removeZone(index)}>Remove</Button>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {(['x', 'y', 'w', 'h'] as const).map((key) => (
                      <NumberInput
                        key={key}
                        aria-label={`${zone.id}.${key}`}
                        value={zone.rect[key]}
                        onChange={(value) => updateZone(index, { rect: { ...zone.rect, [key]: value } })}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Validation</CardTitle></CardHeader>
            <CardContent>
              {validation.ok ? (
                <p className="text-sm text-emerald-600">Valid against map schema v{draft.schemaVersion}.</p>
              ) : (
                <ul className="space-y-1 text-sm text-destructive">
                  {validation.issues.map((issue) => <li key={issue}>{issue}</li>)}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Import / export</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                rows={6}
                value={importText}
                placeholder="Paste a map definition JSON here"
                onChange={(e) => setImportText(e.target.value)}
                className="font-mono text-xs"
              />
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={doImport}>Import</Button>
                <Button size="sm" variant="outline" onClick={() => setImportText(serializeMapDefinition(draft))}>
                  Export current draft
                </Button>
              </div>
              {importIssues.length > 0 && (
                <ul className="space-y-1 text-sm text-destructive">
                  {importIssues.map((issue) => <li key={issue}>{issue}</li>)}
                </ul>
              )}
              <p className="text-xs text-muted-foreground">
                Official maps are source-controlled: paste the export into
                <code className="mx-1">src/world/definitions/maps/</code>and commit it.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </DevLayout>
  );
}

function Overlay({
  definition,
  rect,
  className,
  label,
}: {
  definition: MapDefinition;
  rect: { x: number; y: number; w: number; h: number };
  className?: string;
  label?: string;
}) {
  return (
    <div
      className={`absolute ${className ?? ''}`}
      style={{
        left: `${(rect.x / definition.backgroundSize.w) * 100}%`,
        top: `${(rect.y / definition.backgroundSize.h) * 100}%`,
        width: `${(rect.w / definition.backgroundSize.w) * 100}%`,
        height: `${(rect.h / definition.backgroundSize.h) * 100}%`,
      }}
    >
      {label && <span className="absolute -top-4 left-0 whitespace-nowrap text-[10px] font-medium text-white drop-shadow">{label}</span>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex gap-2">{children}</div>
    </div>
  );
}

function NumberInput({ value, onChange, ...rest }: { value: number; onChange: (value: number) => void } & React.ComponentProps<typeof Input>) {
  return (
    <Input
      {...rest}
      type="number"
      value={value}
      onChange={(e) => {
        const next = Number(e.target.value);
        if (Number.isFinite(next)) onChange(Math.trunc(next));
      }}
    />
  );
}
