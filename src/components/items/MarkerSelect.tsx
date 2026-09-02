import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  MARKER_OPTION_VALUES,
  fromMarkerOption,
  markerOptionLabel,
  toMarkerOption,
} from './markerOptions';

interface MarkerSelectProps {
  /** The form/wire marker: `''` for the primary image. */
  value: string;
  /** Receives a form/wire marker, never the select sentinel. */
  onChange: (marker: string) => void;
  label: string;
  className?: string;
  /** Radix passthrough; the dropdown is uncontrolled by default. */
  open?: boolean;
}

/**
 * The one place image view markers are chosen.
 *
 * Translation happens at this boundary in both directions, so no caller ever
 * sees the select sentinel and no `SelectItem` ever gets an empty value.
 */
export function MarkerSelect({ value, onChange, label, className, open }: MarkerSelectProps) {
  return (
    <Select open={open} value={toMarkerOption(value)} onValueChange={(option) => onChange(fromMarkerOption(option))}>
      <SelectTrigger className={className} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {MARKER_OPTION_VALUES.map((option) => (
          <SelectItem key={option} value={option}>
            {markerOptionLabel(option)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
