import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emptySlot } from '@/farm/slots/types';
import { farmFieldMap } from '@/world/definitions/maps/farm-field';
import type { LoadedRenderpack } from '@/world/renderpack/types';
import { FarmField } from './FarmField';

/**
 * `FarmField` is the component that crashed with "Maximum update depth
 * exceeded" the first time a farm existed: it is the only consumer of
 * `useElementSize`, and it is not reachable until WorldState and MapState have
 * been published. This mounts it directly so the crash cannot hide behind that
 * setup again.
 */

const renderpack: LoadedRenderpack = {
  release: {
    id: 'cozy-pixel-v1',
    version: '1.0.0',
    source: { repo: 'test/pack', commit: 'a'.repeat(40), path: 'renderpacks/cozy-pixel-v1' },
    baseUrl: 'https://cdn.example/pack',
  },
  manifest: { id: 'cozy-pixel-v1', version: '1.0.0', tileSize: 96 },
  tileSize: 96,
  sprites: {
    carrot: { cropId: 'carrot', sheetUrl: 'https://cdn.example/pack/carrot.png', frames: 4 },
  },
  assetUrl: (path: string) => `https://cdn.example/pack/${path}`,
};

afterEach(cleanup);

describe('FarmField', () => {
  it('mounts without an update loop and renders every grid cell', () => {
    const onError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <FarmField
        definition={farmFieldMap}
        renderpack={renderpack}
        readSlot={(x, y) => emptySlot({ x, y })}
        nowSec={1_800_000_000}
        onSlotAction={() => {}}
        onPlantRequest={() => {}}
      />
    );

    expect(screen.getByAltText(farmFieldMap.name)).toBeInTheDocument();

    // React reports "Maximum update depth exceeded" through console.error
    // before it throws, so an empty spy is the strongest available assertion
    // that no loop occurred.
    expect(onError).not.toHaveBeenCalled();
    onError.mockRestore();
  });

  it('renders a planted slot at its computed stage', () => {
    const planted = {
      coord: { x: 0, y: 0 },
      content: {
        type: 'plant' as const,
        plant: { cropId: 'carrot', plantedAt: 1_800_000_000, growthSec: 300, growthUpdatedAt: 1_800_000_000, wetUntil: 1_800_000_300 },
      },
    };

    render(
      <FarmField
        definition={farmFieldMap}
        renderpack={renderpack}
        readSlot={(x, y) => (x === 0 && y === 0 ? planted : emptySlot({ x, y }))}
        nowSec={1_800_000_000}
        onSlotAction={() => {}}
        onPlantRequest={() => {}}
      />
    );

    // 300 banked growth seconds at a 300s stage duration means stage 1.
    expect(screen.getByAltText(farmFieldMap.name)).toBeInTheDocument();
  });

  describe('pointer mapping', () => {
    // A container taller than the scaled background, so the image is
    // letterboxed and viewport.offsetY is non-zero. A square fit would hide an
    // offset bug entirely.
    const CONTAINER = { width: farmFieldMap.backgroundSize.w, height: farmFieldMap.backgroundSize.h + 200 };
    const EXPECTED_OFFSET_Y = 100;

    let rectSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', { value: CONTAINER.width, configurable: true });
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', { value: CONTAINER.height, configurable: true });

      // Model layout: an element's viewport rect reflects its own CSS offset.
      rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const left = Number.parseFloat(this.style.left || '0');
        const top = Number.parseFloat(this.style.top || '0');
        return { left, top, right: left, bottom: top, width: 0, height: 0, x: left, y: top, toJSON: () => ({}) } as DOMRect;
      });
    });

    afterEach(() => rectSpy.mockRestore());

    it('maps a click on the first grid cell to slot (0, 0)', () => {
      const onPlantRequest = vi.fn();

      const { container } = render(
        <FarmField
          definition={farmFieldMap}
          renderpack={renderpack}
          readSlot={(x, y) => emptySlot({ x, y })}
          nowSec={1_800_000_000}
          onSlotAction={() => {}}
          onPlantRequest={onPlantRequest}
        />
      );

      // Grid origin in natural pixels, centred inside the plant area.
      const originX = farmFieldMap.plantArea.x + (farmFieldMap.plantArea.w - farmFieldMap.grid.cols * farmFieldMap.tileSize) / 2;
      const originY = farmFieldMap.plantArea.y + (farmFieldMap.plantArea.h - farmFieldMap.grid.rows * farmFieldMap.tileSize) / 2;

      // Scale is 1 here, so container coordinates are natural + the letterbox.
      const clientX = originX + farmFieldMap.tileSize / 2;
      const clientY = originY + farmFieldMap.tileSize / 2 + EXPECTED_OFFSET_Y;

      fireEvent.click(container.firstChild as Element, { clientX, clientY });

      expect(onPlantRequest).toHaveBeenCalledTimes(1);
      expect(onPlantRequest.mock.calls[0][0].coord).toEqual({ x: 0, y: 0 });
    });

    it('maps a click on the last grid cell to the far corner slot', () => {
      const onPlantRequest = vi.fn();

      const { container } = render(
        <FarmField
          definition={farmFieldMap}
          renderpack={renderpack}
          readSlot={(x, y) => emptySlot({ x, y })}
          nowSec={1_800_000_000}
          onSlotAction={() => {}}
          onPlantRequest={onPlantRequest}
        />
      );

      const originX = farmFieldMap.plantArea.x + (farmFieldMap.plantArea.w - farmFieldMap.grid.cols * farmFieldMap.tileSize) / 2;
      const originY = farmFieldMap.plantArea.y + (farmFieldMap.plantArea.h - farmFieldMap.grid.rows * farmFieldMap.tileSize) / 2;
      const lastCol = farmFieldMap.grid.cols - 1;
      const lastRow = farmFieldMap.grid.rows - 1;

      fireEvent.click(container.firstChild as Element, {
        clientX: originX + lastCol * farmFieldMap.tileSize + farmFieldMap.tileSize / 2,
        clientY: originY + lastRow * farmFieldMap.tileSize + farmFieldMap.tileSize / 2 + EXPECTED_OFFSET_Y,
      });

      expect(onPlantRequest.mock.calls[0][0].coord).toEqual({ x: lastCol, y: lastRow });
    });

    it('ignores a click outside the plantable grid', () => {
      const onPlantRequest = vi.fn();
      const onSlotAction = vi.fn();

      const { container } = render(
        <FarmField
          definition={farmFieldMap}
          renderpack={renderpack}
          readSlot={(x, y) => emptySlot({ x, y })}
          nowSec={1_800_000_000}
          onSlotAction={onSlotAction}
          onPlantRequest={onPlantRequest}
        />
      );

      // Inside the letterbox, above the background entirely.
      fireEvent.click(container.firstChild as Element, { clientX: 10, clientY: 10 });

      expect(onPlantRequest).not.toHaveBeenCalled();
      expect(onSlotAction).not.toHaveBeenCalled();
    });
  });
});
