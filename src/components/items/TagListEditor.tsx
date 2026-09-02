import { useState } from 'react';
import { Plus, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface TagListEditorProps {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  suggestions?: readonly string[];
  placeholder?: string;
  description?: string;
}

/**
 * A repeatable free-text list (contexts, topics).
 *
 * Suggestions are one-click adds, never a closed set: `context` and `t` are
 * open strings on the wire, so a custom value must always be typeable.
 */
export function TagListEditor({ label, values, onChange, suggestions = [], placeholder, description }: TagListEditorProps) {
  const [draft, setDraft] = useState('');

  const add = (value: string) => {
    const trimmed = value.trim();
    if (trimmed === '' || values.includes(trimmed)) return;
    onChange([...values, trimmed]);
    setDraft('');
  };

  const unused = suggestions.filter((s) => !values.includes(s));

  return (
    <div className="space-y-2">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}

      {values.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {values.map((value) => (
            <span key={value} className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs">
              {value}
              <button
                type="button"
                aria-label={`Remove ${value}`}
                onClick={() => onChange(values.filter((v) => v !== value))}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <Input
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(draft);
            }
          }}
        />
        <Button type="button" size="sm" variant="outline" onClick={() => add(draft)} aria-label={`Add ${label}`}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {unused.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {unused.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => add(suggestion)}
              className="rounded border border-dashed px-1.5 py-0.5 text-xs text-muted-foreground hover:border-solid hover:text-foreground"
            >
              + {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
