import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GAME_ITEM_IMAGE_MARKERS } from '@/inventory/package';
import { blankItemForm, PRIMARY_MARKER } from '@/inventory/registry/form-model';
import { formToUnsignedEvent } from '@/inventory/registry/form-event';
import { MarkerSelect } from './MarkerSelect';
import {
  MARKER_OPTION_VALUES,
  PRIMARY_MARKER_OPTION,
  fromMarkerOption,
  markerOptionLabel,
  toMarkerOption,
} from './markerOptions';

/**
 * Radix refuses a `SelectItem` with an empty value, and the primary image
 * marker IS the empty string on the wire. Opening the marker dropdown used to
 * throw "A <Select.Item /> must have a value prop that is not an empty string".
 */

afterEach(cleanup);

describe('marker option encoding', () => {
  it('never produces an empty select value', () => {
    for (const option of MARKER_OPTION_VALUES) {
      expect(option).not.toBe('');
      expect(option.trim()).not.toBe('');
    }
  });

  it('offers the primary option plus every marker the spec defines', () => {
    expect(MARKER_OPTION_VALUES).toEqual([PRIMARY_MARKER_OPTION, ...GAME_ITEM_IMAGE_MARKERS]);
  });

  it('maps the empty wire marker to the non-empty sentinel and back', () => {
    expect(toMarkerOption(PRIMARY_MARKER)).toBe(PRIMARY_MARKER_OPTION);
    expect(fromMarkerOption(PRIMARY_MARKER_OPTION)).toBe(PRIMARY_MARKER);
    expect(fromMarkerOption(PRIMARY_MARKER_OPTION)).toBe('');
  });

  it('leaves real markers untouched in both directions', () => {
    for (const marker of GAME_ITEM_IMAGE_MARKERS) {
      expect(toMarkerOption(marker)).toBe(marker);
      expect(fromMarkerOption(marker)).toBe(marker);
    }
  });

  it('round trips every option', () => {
    for (const option of MARKER_OPTION_VALUES) {
      expect(toMarkerOption(fromMarkerOption(option))).toBe(option);
    }
  });

  it('never uses the literal string "primary", which would be read as a view marker', () => {
    expect(MARKER_OPTION_VALUES).not.toContain('primary');
    expect(fromMarkerOption(PRIMARY_MARKER_OPTION)).not.toBe('primary');
  });

  it('labels the sentinel for humans without leaking it', () => {
    expect(markerOptionLabel(PRIMARY_MARKER_OPTION)).toBe('primary (unmarked)');
    expect(markerOptionLabel('front')).toBe('front');
  });
});

describe('MarkerSelect renders its options', () => {
  it('opens without throwing when the value is the primary marker', () => {
    // Rendering open is what mounts the SelectItems, and mounting them is what
    // used to throw.
    expect(() =>
      render(<MarkerSelect open value={PRIMARY_MARKER} onChange={() => {}} label="Marker 1" />)
    ).not.toThrow();
  });

  it('opens without throwing for a marked view', () => {
    expect(() => render(<MarkerSelect open value="side-left" onChange={() => {}} label="Marker 1" />)).not.toThrow();
  });

  it('renders one option per marker, including the primary one', () => {
    render(<MarkerSelect open value={PRIMARY_MARKER} onChange={() => {}} label="Marker 1" />);

    // The selected label also appears in the trigger, so scope to the listbox.
    const options = screen.getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['primary (unmarked)', ...GAME_ITEM_IMAGE_MARKERS]);
  });

  it('hands the caller the wire marker, not the sentinel', () => {
    const onChange = vi.fn();
    render(<MarkerSelect open value={PRIMARY_MARKER} onChange={onChange} label="Marker 1" />);

    // Radix keyboard/pointer selection is unreliable in jsdom, so drive the
    // translation the component performs rather than the browser gesture.
    const handler = (option: string) => onChange(fromMarkerOption(option));

    handler(PRIMARY_MARKER_OPTION);
    expect(onChange).toHaveBeenLastCalledWith('');

    handler('back');
    expect(onChange).toHaveBeenLastCalledWith('back');
  });
});

describe('the sentinel never reaches the wire', () => {
  it('emits an unmarked image tag when the UI primary option is chosen', () => {
    // Exactly what the component hands the form when "primary (unmarked)" is
    // picked in the dropdown.
    const marker = fromMarkerOption(PRIMARY_MARKER_OPTION);

    const built = formToUnsignedEvent({
      ...blankItemForm(),
      d: 'farm:produce:carrot',
      name: 'Carrot',
      type: 'consumable',
      images: [{ id: 'i1', url: 'https://blossom.primal.net/carrot.png', marker }],
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const imageTags = built.value.tags.filter(([name]) => name === 'image');
    expect(imageTags).toEqual([['image', 'https://blossom.primal.net/carrot.png']]);
    // No third element at all — not an empty one, and not "primary".
    expect(imageTags[0]).toHaveLength(2);
    expect(JSON.stringify(built.value.tags)).not.toContain(PRIMARY_MARKER_OPTION);
  });

  it('emits a marked view when a real marker is chosen', () => {
    const built = formToUnsignedEvent({
      ...blankItemForm(),
      d: 'farm:produce:carrot',
      name: 'Carrot',
      type: 'consumable',
      images: [
        { id: 'i1', url: 'https://blossom.primal.net/a.png', marker: fromMarkerOption(PRIMARY_MARKER_OPTION) },
        { id: 'i2', url: 'https://blossom.primal.net/b.png', marker: fromMarkerOption('back') },
      ],
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.tags.filter(([name]) => name === 'image')).toEqual([
      ['image', 'https://blossom.primal.net/a.png'],
      ['image', 'https://blossom.primal.net/b.png', 'back'],
    ]);
  });
});
