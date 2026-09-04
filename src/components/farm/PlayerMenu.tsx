import { useState } from 'react';
import { ChevronDown, Copy, Info, LogOut, Monitor, Moon, Package, Sun, UserPlus, Users } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import LoginDialog from '@/components/auth/LoginDialog';
import { GameDialog } from '@/components/game/GameDialog';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useLoggedInAccounts } from '@/hooks/useLoggedInAccounts';
import { useLoginActions } from '@/hooks/useLoginActions';
import { useTheme } from '@/hooks/useTheme';
import { useToast } from '@/hooks/useToast';
import type { Theme } from '@/contexts/AppContext';
import { ITEM_REGISTRY_ROUTE } from '@/inventory/routes';
import { abbreviate, safeNpub } from '@/inventory/issuer';
import { genUserName } from '@/lib/genUserName';
import { formatRenderpackRef, type RenderpackRef } from '@/world/renderpack/registry';
import { HUD } from './copy';

/** The technical facts about the current farm, shown on request. */
export interface AboutFarm {
  farmName: string;
  mapName: string;
  mapDefinitionId: string;
  mapRevision: number;
  renderpack: RenderpackRef;
}

const THEME_OPTIONS: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
];

/**
 * Everything about the player that is not gameplay: accounts, appearance,
 * the Item Registry, the technical About, and log out. One avatar button on
 * the rail opens it, so the rail itself stays about the farm.
 */
export function PlayerMenu({ about }: { about?: AboutFarm }) {
  const { user, metadata } = useCurrentUser();
  const { otherUsers, setLogin } = useLoggedInAccounts();
  const { logout } = useLoginActions();
  const { theme, setTheme } = useTheme();
  const [loginOpen, setLoginOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);

  if (!user) return null;

  const displayName = metadata?.name ?? genUserName(user.pubkey);
  const npub = safeNpub(user.pubkey);

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-2 rounded-full border border-border bg-card py-1 pl-1 pr-2.5 text-sm shadow-pill transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`${displayName}: ${HUD.menuLabel}`}
          >
            <Avatar className="h-7 w-7">
              <AvatarImage src={metadata?.picture} alt="" />
              <AvatarFallback className="bg-farm-harvest/30 text-xs font-semibold">{displayName.charAt(0)}</AvatarFallback>
            </Avatar>
            <span className="hidden max-w-[10rem] truncate font-medium sm:inline">{displayName}</span>
            <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="w-60 farm-paper p-1.5">
          <DropdownMenuLabel className="font-normal">
            <p className="truncate font-semibold">{displayName}</p>
            {npub && <p className="truncate font-mono text-[11px] text-muted-foreground">{abbreviate(npub, 12, 6)}</p>}
          </DropdownMenuLabel>

          {otherUsers.length > 0 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="gap-2">
                <Users className="h-4 w-4" />
                {HUD.switchAccount}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="farm-paper p-1.5">
                {otherUsers.map((account) => (
                  <DropdownMenuItem key={account.id} className="gap-2" onSelect={() => setLogin(account.id)}>
                    <Avatar className="h-6 w-6">
                      <AvatarImage src={account.metadata.picture} alt="" />
                      <AvatarFallback className="text-[10px]">{(account.metadata.name ?? genUserName(account.pubkey)).charAt(0)}</AvatarFallback>
                    </Avatar>
                    <span className="truncate">{account.metadata.name ?? genUserName(account.pubkey)}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}

          <DropdownMenuItem className="gap-2" onSelect={() => setLoginOpen(true)}>
            <UserPlus className="h-4 w-4" />
            {HUD.addAccount}
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem asChild className="gap-2">
            <Link to={ITEM_REGISTRY_ROUTE}>
              <Package className="h-4 w-4" />
              {HUD.itemRegistry}
            </Link>
          </DropdownMenuItem>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2">
              {(() => {
                const active = THEME_OPTIONS.find((option) => option.value === theme) ?? THEME_OPTIONS[2];
                return <active.Icon className="h-4 w-4" />;
              })()}
              {HUD.appearance}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="farm-paper p-1.5">
              <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as Theme)}>
                {THEME_OPTIONS.map(({ value, label, Icon }) => (
                  <DropdownMenuRadioItem key={value} value={value} className="gap-2">
                    <Icon className="h-4 w-4" />
                    {label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          {about && (
            <DropdownMenuItem className="gap-2" onSelect={() => setAboutOpen(true)}>
              <Info className="h-4 w-4" />
              {HUD.about}
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />

          <DropdownMenuItem className="gap-2 text-destructive focus:text-destructive" onSelect={() => void logout()}>
            <LogOut className="h-4 w-4" />
            {HUD.logOut}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <LoginDialog isOpen={loginOpen} onClose={() => setLoginOpen(false)} onLogin={() => setLoginOpen(false)} />

      {about && <AboutFarmDialog open={aboutOpen} onOpenChange={setAboutOpen} about={about} npub={npub} />}
    </>
  );
}

function AboutFarmDialog({
  open,
  onOpenChange,
  about,
  npub,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  about: AboutFarm;
  npub: string | null;
}) {
  const { toast } = useToast();

  const copyNpub = async () => {
    if (!npub) return;
    try {
      await navigator.clipboard.writeText(npub);
      toast({ title: HUD.copied });
    } catch {
      toast({ variant: 'destructive', title: HUD.copyFailed, description: npub });
    }
  };

  const rows: { label: string; value: string }[] = [
    { label: 'Farm', value: about.farmName },
    { label: 'Field', value: `${about.mapName} (${about.mapDefinitionId}, revision ${about.mapRevision})` },
    { label: 'Artwork', value: formatRenderpackRef(about.renderpack) },
  ];

  return (
    <GameDialog open={open} onOpenChange={onOpenChange} title={HUD.about} description={HUD.aboutDescription}>
      <dl className="grid gap-3 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="break-words font-medium">{row.value}</dd>
          </div>
        ))}
        {npub && (
          <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2">
            <dt className="text-muted-foreground">Your key</dt>
            <dd className="flex min-w-0 items-center gap-2">
              <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 text-xs">{npub}</code>
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={copyNpub} aria-label={HUD.copyKey}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </dd>
          </div>
        )}
      </dl>
    </GameDialog>
  );
}
