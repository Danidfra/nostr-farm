import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { blankItemForm, type ItemFormState } from '@/inventory/registry/form-model';
import type { ItemImageUploadApi } from '@/hooks/items/useItemImageUpload';
import { ItemForm } from './ItemForm';

const upload: ItemImageUploadApi = {
  entries: [],
  addFiles: () => {},
  setMarker: () => {},
  remove: () => {},
  clear: () => {},
  removeCompleted: () => {},
  uploadAll: async () => [],
  isUploading: false,
  hasPending: false,
  hasFailures: false,
};

const carrot: ItemFormState = {
  ...blankItemForm(),
  d: 'farm:produce:carrot',
  name: 'Carrot',
  type: 'consumable',
};

afterEach(cleanup);

describe('the d field during an in-place edit', () => {
  it('is disabled and explains why', () => {
    render(<ItemForm form={carrot} onChange={() => {}} upload={upload} canUpload={false} lockItemId />);

    const input = screen.getByLabelText('Item id (d)');
    expect(input).toBeDisabled();
    expect(input).toHaveValue('farm:produce:carrot');
    expect(screen.getByText(/Use “Use as template” to create a new item/)).toBeInTheDocument();
  });

  it('emits no change for the d field while locked', () => {
    const onChange = vi.fn();
    render(<ItemForm form={carrot} onChange={onChange} upload={upload} canUpload={false} lockItemId />);

    fireEvent.change(screen.getByLabelText('Item id (d)'), { target: { value: 'farm:produce:tomato' } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('still allows other fields to change while d is locked', () => {
    const onChange = vi.fn();
    render(<ItemForm form={carrot} onChange={onChange} upload={upload} canUpload={false} lockItemId />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Heirloom Carrot' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toMatchObject({ d: 'farm:produce:carrot', name: 'Heirloom Carrot' });
  });
});

describe('the d field on a new item', () => {
  it('is editable and shows the naming hint', () => {
    const onChange = vi.fn();
    render(<ItemForm form={blankItemForm()} onChange={onChange} upload={upload} canUpload={false} />);

    const input = screen.getByLabelText('Item id (d)');
    expect(input).toBeEnabled();
    expect(screen.getByText('Recommended: namespace:category:slug')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'farm:produce:tomato' } });
    expect(onChange.mock.calls[0][0]).toMatchObject({ d: 'farm:produce:tomato' });
  });
});
