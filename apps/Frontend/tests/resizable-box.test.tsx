import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResizableBox } from '../src/features/development/ResizableBox.js';
import { ListDetail } from '../src/features/development/development-ui.js';
import { SplitLayout } from '../src/features/development/SplitLayout.js';
import { TerminalPane } from '../src/features/development/TerminalPane.js';
import { desktopApp } from './helpers/development.js';

/** jsdom has no PointerEvent: a plain event that carries the fields the box reads. */
const pointer = (
  type: string,
  properties: { button?: number; clientX?: number; clientY?: number } = {},
) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.entries({ button: 0, ...properties }).forEach(([key, value]) => {
    Object.defineProperty(event, key, { value });
  });
  return event;
};

const labels = { width: 'W', height: 'H', both: 'B' };

function renderBox(props: { disabled?: boolean } = {}) {
  return render(
    <div data-testid="parent">
      <ResizableBox aria-label="Box" labels={labels} {...props}>
        <p>content</p>
      </ResizableBox>
    </div>,
  );
}
const box = () => screen.getByRole('region', { name: 'Box' });
const handle = (name: string) => screen.getByRole('separator', { name });

beforeEach(() => {
  // The box is 500 x 300 inside a parent that is 900 wide.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const wide =
      this.dataset['testid'] === 'parent' || this.firstElementChild?.tagName === 'SECTION';
    return { width: wide ? 900 : 500, height: 300 } as DOMRect;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'adkDesktop');
});

describe('ResizableBox', () => {
  it('starts full width at its default height', () => {
    renderBox();
    expect(box().style.height).toBe('360px');
    expect(box().style.width).toBe('');
    expect(box().style.maxWidth).toBe('100%');
    expect(box()).toHaveClass('overflow-hidden');
  });

  it('drags the right edge for the width, the bottom edge for the height and the corner for both', () => {
    renderBox();
    fireEvent(handle('W'), pointer('pointerdown', { clientX: 500, clientY: 300 }));
    fireEvent(window, pointer('pointermove', { clientX: 650, clientY: 900 }));
    expect(box().style.width).toBe('650px');
    expect(box().style.height).toBe('360px');
    fireEvent(window, pointer('pointerup'));

    fireEvent(handle('H'), pointer('pointerdown', { clientX: 0, clientY: 300 }));
    fireEvent(window, pointer('pointermove', { clientX: 99, clientY: 400 }));
    expect(box().style.height).toBe('400px');
    expect(box().style.width).toBe('650px');
    fireEvent(window, pointer('pointercancel'));
    // Released: moving the pointer changes nothing.
    fireEvent(window, pointer('pointermove', { clientX: 0, clientY: 0 }));
    expect(box().style.height).toBe('400px');

    fireEvent(handle('B'), pointer('pointerdown', { clientX: 500, clientY: 300 }));
    fireEvent(window, pointer('pointermove', { clientX: 400, clientY: 350 }));
    expect(box().style.width).toBe('400px');
    expect(box().style.height).toBe('350px');
    fireEvent(window, pointer('pointerup'));
  });

  it('never goes past the parent, the maximum height or below the minimum', () => {
    renderBox();
    fireEvent(handle('B'), pointer('pointerdown', { clientX: 0, clientY: 0 }));
    fireEvent(window, pointer('pointermove', { clientX: 5000, clientY: 5000 }));
    expect(box().style.width).toBe('900px');
    expect(box().style.height).toBe('1600px');
    fireEvent(window, pointer('pointermove', { clientX: -5000, clientY: -5000 }));
    expect(box().style.width).toBe('320px');
    expect(box().style.height).toBe('160px');
    fireEvent(window, pointer('pointerup'));
  });

  it('ignores other buttons and restores the page while it is not dragging', () => {
    renderBox();
    fireEvent(handle('W'), pointer('pointerdown', { button: 2, clientX: 0 }));
    fireEvent(window, pointer('pointermove', { clientX: 400 }));
    expect(box().style.width).toBe('');
    fireEvent(handle('W'), pointer('pointerdown', { clientX: 0 }));
    expect(document.body.style.cursor).toBe('col-resize');
    fireEvent(window, pointer('pointerup'));
    expect(document.body.style.cursor).toBe('');
    fireEvent(handle('H'), pointer('pointerdown', { clientX: 0 }));
    expect(document.body.style.cursor).toBe('row-resize');
    fireEvent(window, pointer('pointerup'));
    fireEvent(handle('B'), pointer('pointerdown', { clientX: 0 }));
    expect(document.body.style.cursor).toBe('nwse-resize');
    fireEvent(window, pointer('pointerup'));
  });

  it('resizes with the arrow keys', () => {
    renderBox();
    fireEvent.keyDown(handle('W'), { key: 'ArrowRight' });
    expect(box().style.width).toBe('510px');
    fireEvent.keyDown(handle('W'), { key: 'ArrowLeft' });
    expect(box().style.width).toBe('490px');
    fireEvent.keyDown(handle('W'), { key: 'ArrowDown' });
    expect(box().style.height).toBe('360px');
    fireEvent.keyDown(handle('H'), { key: 'ArrowDown' });
    expect(box().style.height).toBe('310px');
    fireEvent.keyDown(handle('H'), { key: 'ArrowUp' });
    expect(box().style.height).toBe('290px');
    fireEvent.keyDown(handle('H'), { key: 'ArrowLeft' });
    expect(box().style.width).toBe('490px');
    fireEvent.keyDown(handle('B'), { key: 'ArrowRight' });
    fireEvent.keyDown(handle('B'), { key: 'ArrowDown' });
    expect(box().style.width).toBe('510px');
    expect(box().style.height).toBe('310px');
    fireEvent.keyDown(handle('B'), { key: 'a' });
    expect(box().style.height).toBe('310px');
  });

  it('has no size and no handles while disabled', () => {
    renderBox({ disabled: true });
    expect(box().getAttribute('style')).toBeNull();
    expect(screen.queryAllByRole('separator')).toHaveLength(0);
  });
});

describe('Development resizable layout', () => {
  it('lets the list on the left be dragged and keeps the content beside it', () => {
    render(
      <ListDetail label="Sessões" list={<p>list</p>}>
        <p>detail</p>
      </ListDetail>,
    );
    const column = screen.getByRole('complementary', { name: 'Sessões' }).parentElement!;
    expect(column.style.width).toBe('300px');
    const separator = screen.getByRole('separator', { name: 'Redimensionar barra lateral' });
    fireEvent(separator, pointer('pointerdown', { clientX: 300 }));
    fireEvent(window, pointer('pointermove', { clientX: 380 }));
    fireEvent(window, pointer('pointerup'));
    expect(column.style.width).toBe('380px');
    expect(screen.getByText('detail').parentElement!.parentElement).toHaveClass('overflow-hidden');
  });

  it('lets the sidebar of the session be dragged', () => {
    render(
      <SplitLayout plain defaultWidth={270} label="Divisor" side={<p>side</p>}>
        <p>main</p>
      </SplitLayout>,
    );
    expect(screen.getByText('side').parentElement!.style.width).toBe('270px');
  });

  it('puts the terminal in a box that is resized in both directions', () => {
    const { mock } = desktopApp();
    mock['terminalFolder']!.mockResolvedValue({ ok: true, cwd: 'D:\\wt' });
    render(<TerminalPane sessionId="s1" desktop={window.adkDesktop!.development!} />);
    const terminal = screen.getByRole('region', { name: 'Terminal' });
    expect(terminal.style.height).toBe('');
    expect(terminal.style.minHeight).toBe('160px');
    expect(
      screen.getByRole('separator', { name: 'Redimensionar a altura do painel' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('separator', { name: 'Redimensionar a largura do painel' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: 'Redimensionar o painel' })).toBeInTheDocument();
  });
});

describe('SplitLayout', () => {
  const layout = (position: 'left' | 'right' = 'left') =>
    render(
      <SplitLayout sidePosition={position} defaultWidth={200} label="Divisor" side={<p>side</p>}>
        <p>main</p>
      </SplitLayout>,
    );
  const column = () => screen.getByText('side').parentElement!;
  const divider = () => screen.getByRole('separator', { name: 'Divisor' });

  it('hides the column completely or gives it all the room, keeping the divider on screen', () => {
    layout();
    fireEvent(divider(), pointer('pointerdown', { clientX: 200 }));
    fireEvent(window, pointer('pointermove', { clientX: -500 }));
    expect(column().style.width).toBe('0px');
    expect(divider()).toBeInTheDocument();
    expect(divider()).toHaveAttribute('aria-valuenow', '0');
    fireEvent(window, pointer('pointermove', { clientX: 5000 }));
    expect(column().style.width).toBe('494px');
    expect(column().style.maxWidth).toBe('calc(100% - 6px)');
    expect(divider()).toHaveAttribute('aria-valuemax', '494');
    fireEvent(window, pointer('pointerup'));
    expect(document.body.style.cursor).toBe('');
  });

  it('drags the other way when the column is on the right', () => {
    layout('right');
    fireEvent(divider(), pointer('pointerdown', { clientX: 800 }));
    fireEvent(window, pointer('pointermove', { clientX: 700 }));
    expect(column().style.width).toBe('300px');
    fireEvent(window, pointer('pointercancel'));
    fireEvent(window, pointer('pointermove', { clientX: 0 }));
    expect(column().style.width).toBe('300px');
  });

  it('moves with the arrow keys and ignores other keys and buttons', () => {
    layout();
    fireEvent.keyDown(divider(), { key: 'ArrowRight' });
    expect(column().style.width).toBe('210px');
    fireEvent.keyDown(divider(), { key: 'ArrowLeft' });
    fireEvent.keyDown(divider(), { key: 'ArrowLeft' });
    expect(column().style.width).toBe('190px');
    fireEvent.keyDown(divider(), { key: 'a' });
    fireEvent(divider(), pointer('pointerdown', { button: 2, clientX: 0 }));
    fireEvent(window, pointer('pointermove', { clientX: 400 }));
    expect(column().style.width).toBe('190px');
  });

  it('shows no divider line when plain', () => {
    render(
      <SplitLayout plain defaultWidth={100} label="Plain" side={<p>s</p>}>
        <p>m</p>
      </SplitLayout>,
    );
    expect(screen.getByRole('separator', { name: 'Plain' })).toHaveClass('after:bg-transparent');
  });

  it.each(['left', 'right'] as const)(
    'takes the column and its divider away when collapsed, on the %s',
    (position) => {
      const collapsed = (value: boolean) => (
        <SplitLayout
          sidePosition={position}
          collapsed={value}
          defaultWidth={200}
          label="Divisor"
          side={<p>side</p>}
        >
          <p>main</p>
        </SplitLayout>
      );
      const { rerender } = render(collapsed(false));
      const main = screen.getByText('main');
      expect(divider()).toBeInTheDocument();

      rerender(collapsed(true));
      expect(screen.queryByText('side')).toBeNull();
      expect(screen.queryByRole('separator', { name: 'Divisor' })).toBeNull();
      // What fills the rest is the same element, so it keeps its state.
      expect(screen.getByText('main')).toBe(main);

      rerender(collapsed(false));
      expect(screen.getByText('side')).toBeInTheDocument();
      expect(screen.getByText('main')).toBe(main);
    },
  );

  describe('pulled narrower than minWidth', () => {
    const narrow = (onCollapse?: () => void, collapsed = false) =>
      render(
        <SplitLayout
          defaultWidth={200}
          minWidth={150}
          collapsed={collapsed}
          {...(onCollapse ? { onCollapse } : {})}
          label="Divisor"
          side={<p>side</p>}
        >
          <p>main</p>
        </SplitLayout>,
      );

    it('asks to collapse with the arrow keys, and comes back at the default width', () => {
      const onCollapse = vi.fn();
      narrow(onCollapse);
      for (let step = 0; step < 5; step += 1) fireEvent.keyDown(divider(), { key: 'ArrowLeft' });
      expect(divider()).toHaveAttribute('aria-valuenow', '150');
      expect(onCollapse).not.toHaveBeenCalled();
      fireEvent.keyDown(divider(), { key: 'ArrowLeft' });
      expect(onCollapse).toHaveBeenCalledTimes(1);
      expect(divider()).toHaveAttribute('aria-valuenow', '200');
    });

    it('asks to collapse while dragging and stops following the pointer', () => {
      const onCollapse = vi.fn();
      narrow(onCollapse);
      fireEvent(divider(), pointer('pointerdown', { clientX: 200 }));
      fireEvent(window, pointer('pointermove', { clientX: 100 }));
      expect(onCollapse).toHaveBeenCalledTimes(1);
      expect(document.body.style.cursor).toBe('');
      fireEvent(window, pointer('pointermove', { clientX: 20 }));
      expect(divider()).toHaveAttribute('aria-valuenow', '200');
      expect(onCollapse).toHaveBeenCalledTimes(1);
    });

    it('only goes back to the default width when nobody collapses it', () => {
      narrow();
      for (let step = 0; step < 6; step += 1) fireEvent.keyDown(divider(), { key: 'ArrowLeft' });
      expect(divider()).toHaveAttribute('aria-valuenow', '200');
    });

    it('does nothing while it is already collapsed', () => {
      const onCollapse = vi.fn();
      narrow(onCollapse, true);
      expect(onCollapse).not.toHaveBeenCalled();
    });
  });
});

describe('ResizableBox with only the vertical axis', () => {
  it('has just the bottom handle and passes key presses on', () => {
    const keyDown = vi.fn();
    render(
      <ResizableBox aria-label="Top" axes="y" labels={labels} onKeyDown={keyDown}>
        <p>x</p>
      </ResizableBox>,
    );
    expect(screen.queryByRole('separator', { name: 'W' })).toBeNull();
    expect(screen.queryByRole('separator', { name: 'B' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('separator', { name: 'H' }), { key: 'ArrowDown' });
    expect(screen.getByRole('region', { name: 'Top' }).style.height).toBe('310px');
    fireEvent.keyDown(screen.getByRole('region', { name: 'Top' }), { key: 'a' });
    expect(keyDown).toHaveBeenCalled();
  });
});

describe('ResizableBox that fills', () => {
  it('takes the room left by its parent until it is dragged to a size', () => {
    render(
      <div className="flex flex-col">
        <ResizableBox aria-label="Fill" axes="y" fill minHeight={120} labels={labels}>
          <p>x</p>
        </ResizableBox>
      </div>,
    );
    const region = screen.getByRole('region', { name: 'Fill' });
    expect(region.style.height).toBe('');
    expect(region.style.minHeight).toBe('120px');
    expect(region).toHaveClass('flex-1');
    fireEvent(
      screen.getByRole('separator', { name: 'H' }),
      pointer('pointerdown', { clientY: 300 }),
    );
    fireEvent(window, pointer('pointermove', { clientY: 350 }));
    fireEvent(window, pointer('pointerup'));
    expect(region.style.height).toBe('350px');
    expect(region.style.minHeight).toBe('');
    expect(region).not.toHaveClass('flex-1');
  });
});

describe('ResizableBox that is dragged taller than its parent', () => {
  it('keeps its minimum while squeezed and room for its handle once it has a size', () => {
    render(
      <div className="flex flex-col">
        <ResizableBox aria-label="Fill" axes="y" fill minHeight={120} labels={labels}>
          <p>x</p>
        </ResizableBox>
      </div>,
    );
    const region = screen.getByRole('region', { name: 'Fill' });
    const wrapper = region.parentElement!;
    expect(wrapper.style.minHeight).toBe('120px');
    expect(wrapper).not.toHaveClass('last:mb-4');
    fireEvent(
      screen.getByRole('separator', { name: 'H' }),
      pointer('pointerdown', { clientY: 300 }),
    );
    fireEvent(window, pointer('pointermove', { clientY: 900 }));
    fireEvent(window, pointer('pointerup'));
    expect(wrapper.style.minHeight).toBe('');
    expect(wrapper).toHaveClass('last:mb-4');
  });

  it('adds nothing while it is disabled (maximized)', () => {
    render(
      <div className="flex flex-col">
        <ResizableBox aria-label="Max" fill disabled labels={labels}>
          <p>x</p>
        </ResizableBox>
      </div>,
    );
    const wrapper = screen.getByRole('region', { name: 'Max' }).parentElement!;
    expect(wrapper.style.minHeight).toBe('');
    expect(wrapper).not.toHaveClass('last:mb-4');
  });
});
