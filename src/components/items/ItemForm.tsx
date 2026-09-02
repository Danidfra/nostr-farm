import { ChevronDown } from 'lucide-react';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
  CATEGORY_SUGGESTIONS,
  CONTEXT_SUGGESTIONS,
  ITEM_TYPE_OPTIONS,
  RARITY_OPTIONS,
  TOPIC_SUGGESTIONS,
  blankDerivationRow,
  blankEffectRow,
  blankMetadataRow,
  recommendedAlt,
  type ItemFormState,
} from '@/inventory/registry/form-model';
import type { ItemImageUploadApi } from '@/hooks/items/useItemImageUpload';
import { ImageManager } from './ImageManager';
import { TagListEditor } from './TagListEditor';

interface ItemFormProps {
  form: ItemFormState;
  onChange: (form: ItemFormState) => void;
  upload: ItemImageUploadApi;
  canUpload: boolean;
}

/**
 * The item editor.
 *
 * Core fields are always visible; everything a normal item does not need lives
 * behind "Advanced" so the common path — a carrot with a name, a type and a
 * picture — stays short.
 */
export function ItemForm({ form, onChange, upload, canUpload }: ItemFormProps) {
  const patch = (changes: Partial<ItemFormState>) => onChange({ ...form, ...changes });

  return (
    <div className="space-y-5">
      <section className="grid gap-4 sm:grid-cols-2">
        <Field label="Item id (d)" required hint="Recommended: namespace:category:slug">
          <Input value={form.d} placeholder="farm:produce:carrot" onChange={(e) => patch({ d: e.target.value })} />
        </Field>

        <Field label="Name" required>
          <Input value={form.name} placeholder="Carrot" onChange={(e) => patch({ name: e.target.value })} />
        </Field>

        <Field label="Type" required hint="Broad and cross-game. Custom values allowed.">
          <ComboField value={form.type} options={ITEM_TYPE_OPTIONS} placeholder="consumable" onChange={(type) => patch({ type })} />
        </Field>

        <Field label="Category" hint="More specific than type. Custom values allowed.">
          <ComboField value={form.category} options={CATEGORY_SUGGESTIONS} placeholder="food" onChange={(category) => patch({ category })} />
        </Field>
      </section>

      <Field label="Description" hint="Stored in the JSON content, not as a tag.">
        <Textarea
          rows={3}
          value={form.content.description}
          placeholder="A crunchy carrot grown on a Nostr farm."
          onChange={(e) => patch({ content: { ...form.content, description: e.target.value } })}
        />
      </Field>

      <ImageManager rows={form.images} onChange={(images) => patch({ images })} upload={upload} canUpload={canUpload} />

      <div className="grid gap-4 sm:grid-cols-2">
        <TagListEditor
          label="Contexts"
          values={form.contexts}
          onChange={(contexts) => patch({ contexts })}
          suggestions={CONTEXT_SUGGESTIONS}
          placeholder="game:farm"
          description="Where this item was designed to be used. A hint, not a restriction."
        />
        <TagListEditor
          label="Topics (t)"
          values={form.topics}
          onChange={(topics) => patch({ topics })}
          suggestions={TOPIC_SUGGESTIONS}
          placeholder="edible"
          description="Indexable and cross-game: how another game finds this item generically."
        />
      </div>

      <section className="grid gap-4 sm:grid-cols-3">
        <Field label="Rarity" hint="Display metadata only.">
          <ComboField value={form.rarity} options={RARITY_OPTIONS} placeholder="common" onChange={(rarity) => patch({ rarity })} />
        </Field>
        <Field label="Max stack">
          <Input value={form.maxStack} placeholder="99" inputMode="numeric" onChange={(e) => patch({ maxStack: e.target.value })} />
        </Field>
        <Field label="Symbol" hint="Short ticker for currencies and materials.">
          <Input value={form.symbol} placeholder="CARROT" onChange={(e) => patch({ symbol: e.target.value })} />
        </Field>
      </section>

      <Advanced form={form} patch={patch} />
    </div>
  );
}

function Advanced({ form, patch }: { form: ItemFormState; patch: (changes: Partial<ItemFormState>) => void }) {
  return (
    <Collapsible className="rounded-lg border">
      <CollapsibleTrigger className="flex w-full items-center justify-between p-3 text-sm font-medium">
        Advanced
        <ChevronDown className="h-4 w-4" />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-5 border-t p-3">
        <section className="grid gap-4 sm:grid-cols-2">
          <Field label="Version" hint="Metadata version hint, not the event version.">
            <Input value={form.version} placeholder="1" onChange={(e) => patch({ version: e.target.value })} />
          </Field>
          <Field label="Alt" hint={`Auto-generated as "${recommendedAlt(form.name || '<name>')}" when blank.`}>
            <Input value={form.alt} placeholder={recommendedAlt(form.name || '<name>')} onChange={(e) => patch({ alt: e.target.value })} />
          </Field>
          <Field label="3D model URL">
            <Input value={form.model3d} placeholder="https://…/carrot.glb" onChange={(e) => patch({ model3d: e.target.value })} />
          </Field>
          <Field label="Audio URL">
            <Input value={form.audio} placeholder="https://…/crunch.wav" onChange={(e) => patch({ audio: e.target.value })} />
          </Field>
        </section>

        <RowEditor
          label="Effects (content.effects)"
          hint="Context-keyed hints. Other games decide what an item actually does — publish only semantics you own."
          rows={form.content.effects}
          onAdd={() => patch({ content: { ...form.content, effects: [...form.content.effects, blankEffectRow()] } })}
          onRemove={(id) =>
            patch({ content: { ...form.content, effects: form.content.effects.filter((r) => r.id !== id) } })
          }
          render={(row) => (
            <>
              <Input
                className="w-40"
                value={row.context}
                placeholder="game:farm"
                aria-label="Effect context"
                onChange={(e) =>
                  patch({
                    content: {
                      ...form.content,
                      effects: form.content.effects.map((r) => (r.id === row.id ? { ...r, context: e.target.value } : r)),
                    },
                  })
                }
              />
              <Input
                value={row.key}
                placeholder="freshness"
                aria-label="Effect key"
                onChange={(e) =>
                  patch({
                    content: {
                      ...form.content,
                      effects: form.content.effects.map((r) => (r.id === row.id ? { ...r, key: e.target.value } : r)),
                    },
                  })
                }
              />
              <Input
                className="w-28"
                value={row.value}
                placeholder="5"
                aria-label="Effect value"
                onChange={(e) =>
                  patch({
                    content: {
                      ...form.content,
                      effects: form.content.effects.map((r) => (r.id === row.id ? { ...r, value: e.target.value } : r)),
                    },
                  })
                }
              />
            </>
          )}
        />

        <RowEditor
          label="Metadata (content.metadata)"
          hint="Machine-readable extras that are not worth a top-level tag."
          rows={form.content.metadata}
          onAdd={() => patch({ content: { ...form.content, metadata: [...form.content.metadata, blankMetadataRow()] } })}
          onRemove={(id) =>
            patch({ content: { ...form.content, metadata: form.content.metadata.filter((r) => r.id !== id) } })
          }
          render={(row) => (
            <>
              <Input
                value={row.key}
                placeholder="craftingGroup"
                aria-label="Metadata key"
                onChange={(e) =>
                  patch({
                    content: {
                      ...form.content,
                      metadata: form.content.metadata.map((r) => (r.id === row.id ? { ...r, key: e.target.value } : r)),
                    },
                  })
                }
              />
              <Input
                value={row.value}
                placeholder="vegetables"
                aria-label="Metadata value"
                onChange={(e) =>
                  patch({
                    content: {
                      ...form.content,
                      metadata: form.content.metadata.map((r) => (r.id === row.id ? { ...r, value: e.target.value } : r)),
                    },
                  })
                }
              />
            </>
          )}
        />

        <Field label="Visual (content.visual)" hint="Free-form JSON object for rendering hints.">
          <Textarea
            rows={3}
            className="font-mono text-xs"
            value={form.content.visual}
            placeholder='{ "sprite": "https://…/carrot.svg" }'
            onChange={(e) => patch({ content: { ...form.content, visual: e.target.value } })}
          />
        </Field>

        <RowEditor
          label="Based on (a … based_on)"
          hint="Derivation references to other 31632 addresses."
          rows={form.basedOn}
          onAdd={() => patch({ basedOn: [...form.basedOn, blankDerivationRow()] })}
          onRemove={(id) => patch({ basedOn: form.basedOn.filter((r) => r.id !== id) })}
          render={(row) => (
            <>
              <Input
                value={row.address}
                placeholder="31632:<pubkey>:<d>"
                aria-label="Based-on address"
                onChange={(e) =>
                  patch({ basedOn: form.basedOn.map((r) => (r.id === row.id ? { ...r, address: e.target.value } : r)) })
                }
              />
              <Input
                className="w-56"
                value={row.relay}
                placeholder="wss://relay… (optional)"
                aria-label="Based-on relay"
                onChange={(e) =>
                  patch({ basedOn: form.basedOn.map((r) => (r.id === row.id ? { ...r, relay: e.target.value } : r)) })
                }
              />
            </>
          )}
        />

        {form.extraTags.length > 0 && (
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Preserved tags</Label>
            <p className="text-xs text-muted-foreground">
              Tags this editor does not manage, kept exactly as published so an edit cannot drop them.
            </p>
            <pre className="overflow-auto rounded bg-muted p-2 font-mono text-xs">
              {JSON.stringify(form.extraTags, null, 2)}
            </pre>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function RowEditor<T extends { id: string }>({
  label,
  hint,
  rows,
  onAdd,
  onRemove,
  render,
}: {
  label: string;
  hint?: string;
  rows: T[];
  onAdd: () => void;
  onRemove: (id: string) => void;
  render: (row: T) => React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">{label}</Label>
        <Button type="button" size="sm" variant="outline" onClick={onAdd}>
          Add
        </Button>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {rows.map((row) => (
        <div key={row.id} className="flex gap-2">
          {render(row)}
          <Button type="button" size="sm" variant="ghost" onClick={() => onRemove(row.id)}>
            Remove
          </Button>
        </div>
      ))}
    </div>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">
        {label}
        {required && <span className="ml-1 text-destructive">*</span>}
      </Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * A suggestion dropdown that still accepts a custom value.
 *
 * `type`, `category` and `rarity` are open strings on the wire, so the field is
 * a text input with a companion picker rather than a closed select.
 */
function ComboField({
  value,
  options,
  placeholder,
  onChange,
}: {
  value: string;
  options: readonly string[];
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex gap-2">
      <Input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      <Select value={options.includes(value) ? value : ''} onValueChange={onChange}>
        <SelectTrigger className="w-32 shrink-0" aria-label={`${placeholder ?? 'value'} suggestions`}>
          <SelectValue placeholder="Pick…" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
