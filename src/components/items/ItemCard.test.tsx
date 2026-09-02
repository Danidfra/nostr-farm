import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseGameItemDefinition, type GameItemDefinition } from '@/inventory/package';
import { FARM_OFFICIAL_ISSUER_PUBKEY } from '@/inventory/constants';
import { ItemCard } from './ItemCard';

const EXTERNAL = 'b'.repeat(64);

function item(pubkey: string, images: string[][] = []): GameItemDefinition {
  return parseGameItemDefinition({
    kind: 31632,
    pubkey,
    created_at: 0,
    tags: [
      ['d', 'farm:produce:carrot'],
      ['name', 'Carrot'],
      ['type', 'consumable'],
      ['category', 'food'],
      ...images,
      ['context', 'cross-game'],
      ['t', 'edible'],
    ],
    content: '',
  })!;
}

const noop = () => {};

afterEach(cleanup);

describe('ItemCard issuer distinction', () => {
  it('labels an item from the Farm issuer as official', () => {
    render(<ItemCard item={item(FARM_OFFICIAL_ISSUER_PUBKEY)} signerPubkey={null} onEdit={noop} onDerive={noop} onCopyAddress={noop} />);
    expect(screen.getByText('Official Farm Item')).toBeInTheDocument();
    expect(screen.queryByText('External Item')).not.toBeInTheDocument();
  });

  it('labels an item from any other issuer as external', () => {
    render(<ItemCard item={item(EXTERNAL)} signerPubkey={null} onEdit={noop} onDerive={noop} onCopyAddress={noop} />);
    expect(screen.getByText('External Item')).toBeInTheDocument();
    expect(screen.queryByText('Official Farm Item')).not.toBeInTheDocument();
  });

  it('shows the abbreviated issuer so the identity stays inspectable', () => {
    render(<ItemCard item={item(EXTERNAL)} signerPubkey={null} onEdit={noop} onDerive={noop} onCopyAddress={noop} />);
    expect(screen.getByText(/^npub1.*…/)).toBeInTheDocument();
  });
});

describe('ItemCard edit permission', () => {
  it('offers Edit only when the signer is the item issuer', () => {
    render(
      <ItemCard item={item(FARM_OFFICIAL_ISSUER_PUBKEY)} signerPubkey={FARM_OFFICIAL_ISSUER_PUBKEY} onEdit={noop} onDerive={noop} onCopyAddress={noop} />
    );
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use as template' })).not.toBeInTheDocument();
  });

  it('offers a template copy instead when the signer is somebody else', () => {
    render(<ItemCard item={item(FARM_OFFICIAL_ISSUER_PUBKEY)} signerPubkey={EXTERNAL} onEdit={noop} onDerive={noop} onCopyAddress={noop} />);
    expect(screen.getByRole('button', { name: 'Use as template' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('offers no edit at all when signed out', () => {
    render(<ItemCard item={item(FARM_OFFICIAL_ISSUER_PUBKEY)} signerPubkey={null} onEdit={noop} onDerive={noop} onCopyAddress={noop} />);
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });
});

describe('ItemCard primary image', () => {
  it('renders the unmarked image, not a marked view', () => {
    render(
      <ItemCard
        item={item(FARM_OFFICIAL_ISSUER_PUBKEY, [
          ['image', 'https://example.com/front.png', 'front'],
          ['image', 'https://example.com/main.png'],
        ])}
        signerPubkey={null}
        onEdit={noop}
        onDerive={noop}
        onCopyAddress={noop}
      />
    );
    expect(screen.getByAltText('Carrot')).toHaveAttribute('src', 'https://example.com/main.png');
  });

  it('falls back to the first marked view when there is no unmarked image', () => {
    render(
      <ItemCard
        item={item(FARM_OFFICIAL_ISSUER_PUBKEY, [['image', 'https://example.com/side.png', 'side-left']])}
        signerPubkey={null}
        onEdit={noop}
        onDerive={noop}
        onCopyAddress={noop}
      />
    );
    expect(screen.getByAltText('Carrot')).toHaveAttribute('src', 'https://example.com/side.png');
  });

  it('renders no image element when the item has none', () => {
    render(<ItemCard item={item(FARM_OFFICIAL_ISSUER_PUBKEY)} signerPubkey={null} onEdit={noop} onDerive={noop} onCopyAddress={noop} />);
    expect(screen.queryByAltText('Carrot')).not.toBeInTheDocument();
  });
});

describe('ItemCard address', () => {
  it('copies the full 31632:pubkey:d address, never the d alone', async () => {
    const onCopyAddress = vi.fn();
    render(
      <ItemCard item={item(FARM_OFFICIAL_ISSUER_PUBKEY)} signerPubkey={null} onEdit={noop} onDerive={noop} onCopyAddress={onCopyAddress} />
    );

    screen.getByRole('button', { name: /Copy address/ }).click();
    expect(onCopyAddress).toHaveBeenCalledWith(`31632:${FARM_OFFICIAL_ISSUER_PUBKEY}:farm:produce:carrot`);
  });
});
