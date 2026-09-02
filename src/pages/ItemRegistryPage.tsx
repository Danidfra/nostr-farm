import { useMemo, useState } from 'react';
import { useSeoMeta } from '@unhead/react';
import { Link } from 'react-router-dom';
import { FileJson, Loader2, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LoginArea } from '@/components/auth/LoginArea';
import { ThemeToggle } from '@/components/ThemeToggle';
import { ItemCard } from '@/components/items/ItemCard';
import { ItemForm } from '@/components/items/ItemForm';
import { ImportEventDialog } from '@/components/items/ImportEventDialog';
import { IssuerBadge } from '@/components/items/IssuerBadge';
import { PublishReviewDialog } from '@/components/items/PublishReviewDialog';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useToast } from '@/hooks/useToast';
import { useItemDefinitions, type RegistryScope } from '@/hooks/items/useItemDefinitions';
import { useItemImageUpload } from '@/hooks/items/useItemImageUpload';
import { usePublishItemDefinition, type PublishItemDefinitionResult } from '@/hooks/items/usePublishItemDefinition';
import type { GameItemDefinition } from '@/inventory/package';
import { blankItemForm, type ItemFormState } from '@/inventory/registry/form-model';
import {
  applyFormEdit,
  deriveAsNewItem,
  eventToForm,
  formAddress,
  formToUnsignedEvent,
  isInPlaceEdit,
  lockedItemId,
  type ImportMode,
  type ImportedEvent,
} from '@/inventory/registry/form-event';
import { applyFilters, blankFilters, facetValues, sortForDisplay, type RegistryFilters } from '@/inventory/registry/filters';

/**
 * The Game Item Registry / Item Studio.
 *
 * Two halves that share one identity model: a browser over kind:31632
 * definitions, and an editor that publishes them. Every protocol decision is
 * delegated to `@nostr-games/inventory` through `@/inventory/package`; this
 * page owns presentation and workflow only.
 */
export default function ItemRegistryPage() {
  useSeoMeta({
    title: 'Item Registry — Nostr Farm',
    description: 'Browse and publish Nostr game item definitions (kind:31632).',
  });

  const { user } = useCurrentUser();
  const { toast } = useToast();

  const [scope, setScope] = useState<RegistryScope>('farm');
  const [filters, setFilters] = useState<RegistryFilters>(blankFilters);
  const [tab, setTab] = useState('browse');
  const [form, setForm] = useState<ItemFormState>(blankItemForm);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [result, setResult] = useState<PublishItemDefinitionResult | null>(null);

  const definitions = useItemDefinitions(scope);
  const upload = useItemImageUpload();
  const publish = usePublishItemDefinition();

  const items = useMemo(
    () => sortForDisplay(applyFilters((definitions.data ?? []).map((record) => record.definition), filters)),
    [definitions.data, filters]
  );
  const allItems = useMemo(() => (definitions.data ?? []).map((record) => record.definition), [definitions.data]);

  const built = useMemo(() => formToUnsignedEvent(form), [form]);
  const address = formAddress(form, user?.pubkey ?? null);
  const signerPubkey = user?.pubkey ?? null;

  // `lockedItemId` is non-null whenever the form came from the signer's own
  // published definition; `isInPlaceEdit` additionally requires the address to
  // still match, so the "replaces this definition" promise is only made while
  // it is actually true.
  const idLocked = lockedItemId(form, signerPubkey) !== null;
  const isEditing = isInPlaceEdit(form, signerPubkey);

  // Identity is not left to a disabled input: a `d` change on a loaded item is
  // refused here too.
  const updateForm = (next: ItemFormState) => setForm((current) => applyFormEdit(current, next, signerPubkey));

  const copyAddress = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast({ title: 'Address copied', description: value });
    } catch {
      toast({ variant: 'destructive', title: 'Could not copy', description: value });
    }
  };

  const loadIntoEditor = (item: GameItemDefinition, derive: boolean) => {
    const record = (definitions.data ?? []).find((entry) => entry.address === item.address);
    if (!record) return;

    const loaded = eventToForm(record.event, record.relays);
    if (!loaded.ok) {
      toast({ variant: 'destructive', title: 'Could not load item', description: loaded.error });
      return;
    }
    setForm(derive ? deriveAsNewItem(loaded.value.form) : loaded.value.form);
    setResult(null);
    setTab('create');
  };

  /**
   * Adopt an imported event. `applyFormEdit` is bypassed on purpose: this
   * replaces the whole form rather than editing the current one, and the
   * imported form already carries the right provenance for its mode.
   */
  const handleImported = (imported: ImportedEvent, mode: ImportMode) => {
    setForm(imported.form);
    setResult(null);
    setTab('create');
    toast({
      title: mode === 'existing' ? 'Loaded for editing' : 'Imported as a new item',
      description: imported.warnings.length > 0 ? imported.warnings.join('; ') : imported.form.d,
    });
  };

  const openReview = () => {
    setResult(null);
    setReviewOpen(true);
  };

  const doPublish = async () => {
    if (!built.ok) return;
    try {
      const published = await publish.mutateAsync({ template: built.value });
      setResult(published);
      if (published.reachedAnyRelay) {
        definitions.refetch();
        toast({ title: 'Published', description: published.record?.address ?? '' });
      }
    } catch (error) {
      toast({ variant: 'destructive', title: 'Publish failed', description: (error as Error).message });
      setReviewOpen(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex items-baseline gap-3">
          <Link to="/" className="text-sm text-muted-foreground hover:underline">
            ← Farm
          </Link>
          <h1 className="text-lg font-bold">Item Registry</h1>
          <span className="text-xs text-muted-foreground">kind:31632</span>
        </div>
        <div className="flex items-center gap-3">
          {user ? <IssuerBadge pubkey={user.pubkey} /> : null}
          <ThemeToggle />
          <LoginArea />
        </div>
      </header>

      <main className="mx-auto max-w-6xl p-4">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="browse">Browse</TabsTrigger>
            <TabsTrigger value="create">{isEditing ? 'Edit item' : 'Create item'}</TabsTrigger>
          </TabsList>

          <TabsContent value="browse" className="space-y-4 pt-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Filters</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-56 flex-1 space-y-1">
                    <Label className="text-xs text-muted-foreground">Search name or id</Label>
                    <Input
                      value={filters.search}
                      placeholder="carrot"
                      onChange={(e) => setFilters({ ...filters, search: e.target.value })}
                    />
                  </div>

                  <FilterSelect
                    label="Query scope"
                    value={scope}
                    onChange={(value) => setScope(value as RegistryScope)}
                    options={[
                      { value: 'farm', label: 'Farm official issuer' },
                      { value: 'all', label: 'All Nostr items' },
                    ]}
                  />

                  <FilterSelect
                    label="Issuer"
                    value={filters.issuer}
                    onChange={(issuer) => setFilters({ ...filters, issuer: issuer as RegistryFilters['issuer'] })}
                    options={[
                      { value: 'all', label: 'Any' },
                      { value: 'official', label: 'Official Farm' },
                      { value: 'external', label: 'External' },
                    ]}
                  />

                  <Button variant="outline" size="icon" onClick={() => definitions.refetch()} aria-label="Refresh">
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                </div>

                <div className="flex flex-wrap items-end gap-3">
                  <FacetSelect label="Type" facet="type" items={allItems} value={filters.type} onChange={(type) => setFilters({ ...filters, type })} />
                  <FacetSelect label="Category" facet="category" items={allItems} value={filters.category} onChange={(category) => setFilters({ ...filters, category })} />
                  <FacetSelect label="Context" facet="context" items={allItems} value={filters.context} onChange={(context) => setFilters({ ...filters, context })} />
                  <FacetSelect label="Topic" facet="topic" items={allItems} value={filters.topic} onChange={(topic) => setFilters({ ...filters, topic })} />
                  <div className="min-w-48 space-y-1">
                    <Label className="text-xs text-muted-foreground">Issuer pubkey starts with</Label>
                    <Input
                      value={filters.issuerQuery}
                      placeholder="f47aaf2e"
                      onChange={(e) => setFilters({ ...filters, issuerQuery: e.target.value })}
                    />
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setFilters(blankFilters())}>
                    Clear
                  </Button>
                </div>

                {scope === 'all' && (
                  <p className="text-xs text-muted-foreground">
                    Querying every kind:31632 issuer on the registry relays. The default scope asks only for the official
                    Farm issuer, which is one indexed query.
                  </p>
                )}
              </CardContent>
            </Card>

            {definitions.isLoading && (
              <div className="grid gap-3 md:grid-cols-2">
                {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28 w-full rounded-lg" />)}
              </div>
            )}

            {definitions.isError && (
              <p className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                Could not load item definitions: {(definitions.error as Error).message}
              </p>
            )}

            {!definitions.isLoading && !definitions.isError && (
              <>
                <p className="text-sm text-muted-foreground">
                  {items.length} of {allItems.length} item{allItems.length === 1 ? '' : 's'}
                </p>
                <div className="grid gap-3 md:grid-cols-2">
                  {items.map((item) => (
                    <ItemCard
                      key={item.address}
                      item={item}
                      signerPubkey={user?.pubkey ?? null}
                      onEdit={(value) => loadIntoEditor(value, false)}
                      onDerive={(value) => loadIntoEditor(value, true)}
                      onCopyAddress={copyAddress}
                    />
                  ))}
                </div>
                {items.length === 0 && (
                  <p className="rounded border border-dashed p-6 text-center text-sm text-muted-foreground">
                    No items match. Try the “All Nostr items” scope, or create one.
                  </p>
                )}
              </>
            )}
          </TabsContent>

          <TabsContent value="create" className="space-y-4 pt-4">
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle className="text-base">{isEditing ? 'Edit item definition' : 'New item definition'}</CardTitle>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
                    <FileJson className="mr-2 h-4 w-4" />
                    Import JSON
                  </Button>
                  {form.loaded && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setForm(blankItemForm());
                        setResult(null);
                      }}
                    >
                      Start blank
                    </Button>
                  )}
                  <Button size="sm" disabled={!built.ok} onClick={openReview}>
                    Review event
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {form.loaded && !idLocked && (
                  <p className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
                    This definition was issued by another key, so it cannot be edited in place — publishing will create a
                    new item under yours, recorded as a <code>based_on</code> derivation.
                  </p>
                )}
                {isEditing && (
                  <p className="rounded border border-sky-500/40 bg-sky-500/10 p-2 text-xs">
                    Editing <code className="break-all">{form.loaded?.address}</code>. Re-publishing replaces it.
                  </p>
                )}
                {!user && (
                  <p className="rounded border border-muted bg-muted/40 p-2 text-xs text-muted-foreground">
                    You can build and preview an item without signing in. Publishing and image upload need a signer.
                  </p>
                )}
                {!built.ok && (
                  <p className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                    {built.error}
                  </p>
                )}

                <ItemForm form={form} onChange={updateForm} upload={upload} canUpload={!!user} lockItemId={idLocked} />
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>

      <ImportEventDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        signerPubkey={signerPubkey}
        onImported={handleImported}
      />

      <PublishReviewDialog
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        template={built.ok ? built.value : null}
        error={built.ok ? null : built.error}
        signerPubkey={user?.pubkey ?? null}
        address={address}
        isEditing={isEditing}
        isPublishing={publish.isPending}
        result={result}
        onPublish={doPublish}
        onCopyAddress={copyAddress}
      />

      {publish.isPending && (
        <div className="pointer-events-none fixed bottom-4 right-4 flex items-center gap-2 rounded bg-foreground px-3 py-2 text-sm text-background">
          <Loader2 className="h-4 w-4 animate-spin" />
          Publishing…
        </div>
      )}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="min-w-44 space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const ANY = '__any__';

function FacetSelect({
  label,
  facet,
  items,
  value,
  onChange,
}: {
  label: string;
  facet: 'type' | 'category' | 'context' | 'topic';
  items: readonly GameItemDefinition[];
  value: string;
  onChange: (value: string) => void;
}) {
  const values = facetValues(items, facet);
  return (
    <div className="min-w-40 space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value === '' ? ANY : value} onValueChange={(next) => onChange(next === ANY ? '' : next)}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>Any</SelectItem>
          {values.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
