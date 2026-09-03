import { useState, type ReactNode } from 'react';
import { KeyRound, Share2, Sprout } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoginArea } from '@/components/auth/LoginArea';
import { Panel, PanelDescription, PanelTitle } from '@/components/game/Panel';
import { DEFAULT_MAP_DEFINITION_ID, getMapDefinition } from '@/world/definitions/registry';
import { DEFAULT_RENDERPACK_REF, resolveRenderpack } from '@/world/renderpack/registry';
import { renderpackAssetUrl } from '@/world/renderpack/load';
import { CREATE_FARM, ERRORS, LOADING, WELCOME } from './copy';

/**
 * The screens in front of the field: sign in, create, loading, error.
 *
 * Every one of them sits on the same backdrop, the default map's own
 * artwork, so the first thing a visitor sees is the game they are about to
 * play rather than a form on a gradient.
 */

const POINT_ICONS = [Sprout, KeyRound, Share2] as const;

/** Shown when nobody is signed in. */
export function WelcomePanel() {
  return (
    <GateScreen>
      <Panel className="w-full max-w-lg">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{WELCOME.eyebrow}</p>
        <PanelTitle className="mt-2 text-3xl">{WELCOME.title}</PanelTitle>
        <PanelDescription className="mt-3">{WELCOME.description}</PanelDescription>

        <ul className="mt-5 grid gap-3 sm:grid-cols-3">
          {WELCOME.points.map((point, index) => {
            const Icon = POINT_ICONS[index] ?? Sprout;
            return (
              <li key={point.title} className="rounded-lg border border-border/70 bg-background/60 p-3">
                <Icon className="h-5 w-5 text-primary" aria-hidden />
                <p className="mt-2 text-sm font-semibold">{point.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{point.text}</p>
              </li>
            );
          })}
        </ul>

        <div className="mt-6 flex flex-col items-center gap-3">
          <LoginArea />
        </div>

        <Disclosure title={WELCOME.howTitle}>{WELCOME.how}</Disclosure>
      </Panel>
    </GateScreen>
  );
}

/** Shown when the signed-in player has no farm yet. */
export function CreateFarmPanel({ onCreate, isCreating }: { onCreate: (name: string) => void; isCreating: boolean }) {
  const [name, setName] = useState<string>(CREATE_FARM.defaultName);

  return (
    <GateScreen>
      <Panel className="w-full max-w-md">
        <PanelTitle>{CREATE_FARM.title}</PanelTitle>
        <PanelDescription className="mt-2">{CREATE_FARM.description}</PanelDescription>

        <form
          className="mt-5 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!isCreating) onCreate(name);
          }}
        >
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={CREATE_FARM.placeholder}
            maxLength={60}
            aria-label="Farm name"
            className="h-11 bg-background/70 font-display text-lg"
          />
          <Button type="submit" size="lg" disabled={isCreating} className="shrink-0">
            {isCreating ? CREATE_FARM.busy : CREATE_FARM.action}
          </Button>
        </form>

        <Disclosure title={CREATE_FARM.howTitle}>{CREATE_FARM.how}</Disclosure>
      </Panel>
    </GateScreen>
  );
}

/**
 * Shown when something the player cannot fix went wrong. The friendly
 * message is the headline; the technical one is there for whoever wants it.
 */
export function FarmErrorPanel({
  title,
  message,
  detail,
  onRetry,
}: {
  title: string;
  message: string;
  /** The underlying error text, behind a disclosure. */
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <GateScreen>
      <Panel className="w-full max-w-md">
        <PanelTitle>{title}</PanelTitle>
        <PanelDescription className="mt-2">{message}</PanelDescription>
        {onRetry && (
          <Button variant="outline" className="mt-5" onClick={onRetry}>
            {ERRORS.retry}
          </Button>
        )}
        {detail && (
          <Disclosure title={ERRORS.detailsTitle}>
            <span className="break-words font-mono text-xs">{detail}</span>
          </Disclosure>
        )}
      </Panel>
    </GateScreen>
  );
}

/** Shown while the farm or its artwork is on its way. */
export function LoadingFieldPanel() {
  return (
    <GateScreen>
      <div className="farm-frame flex aspect-[3/2] w-full max-w-3xl items-center justify-center bg-farm-meadow/60" role="status">
        <span className="rounded-full bg-card/90 px-4 py-1.5 font-display text-lg text-card-foreground shadow-pill motion-safe:animate-pulse">
          {LOADING.field}
        </span>
      </div>
    </GateScreen>
  );
}

/** The default map's artwork, softened, behind whichever panel is showing. */
function GateScreen({ children }: { children: ReactNode }) {
  const backdrop = gateBackdropUrl();
  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden p-4 sm:p-6">
      {backdrop && (
        <img
          src={backdrop}
          alt=""
          aria-hidden
          draggable={false}
          className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover opacity-70 blur-[2px] saturate-[.85]"
          style={{ imageRendering: 'pixelated' }}
        />
      )}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-background/30 via-transparent to-background/70" aria-hidden />
      <div className="relative z-10 flex w-full justify-center">{children}</div>
    </div>
  );
}

function gateBackdropUrl(): string | null {
  const release = resolveRenderpack(DEFAULT_RENDERPACK_REF);
  const map = getMapDefinition(DEFAULT_MAP_DEFINITION_ID);
  if (!release || !map) return null;
  return renderpackAssetUrl(release, map.background);
}

function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="group mt-5 border-t border-border/70 pt-3 text-sm">
      <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">{title}</summary>
      <p className="mt-2 leading-relaxed text-muted-foreground">{children}</p>
    </details>
  );
}

