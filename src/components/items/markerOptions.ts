import { GAME_ITEM_IMAGE_MARKERS } from '@/inventory/package';
import { PRIMARY_MARKER } from '@/inventory/registry/form-model';

/**
 * Presentation-only encoding of image view markers for Radix `Select`.
 *
 * On the wire the primary image is an `image` tag with NO marker, which the
 * form models as the empty string ({@link PRIMARY_MARKER}). Radix refuses a
 * `SelectItem` whose value is `''` — it reserves the empty string for "no
 * selection, show the placeholder" — so the dropdown needs a non-empty stand-in.
 *
 * {@link PRIMARY_MARKER_OPTION} is that stand-in and it exists ONLY inside
 * select state. Everything crossing into form state goes through
 * {@link fromMarkerOption}, so the sentinel can never reach a tag. The literal
 * string `primary` is deliberately not used: if it ever leaked it would be read
 * by other clients as an unknown view marker, and the item would silently have
 * no primary image at all.
 */
export const PRIMARY_MARKER_OPTION = '__primary__';

/** Every value the marker dropdowns may offer. None is ever empty. */
export const MARKER_OPTION_VALUES: readonly string[] = Object.freeze([
  PRIMARY_MARKER_OPTION,
  ...GAME_ITEM_IMAGE_MARKERS,
]);

/** Form/wire marker -> select value. */
export function toMarkerOption(marker: string): string {
  return marker === PRIMARY_MARKER ? PRIMARY_MARKER_OPTION : marker;
}

/** Select value -> form/wire marker. */
export function fromMarkerOption(option: string): string {
  return option === PRIMARY_MARKER_OPTION ? PRIMARY_MARKER : option;
}

/** Human label for a select value. */
export function markerOptionLabel(option: string): string {
  return option === PRIMARY_MARKER_OPTION ? 'primary (unmarked)' : option;
}
