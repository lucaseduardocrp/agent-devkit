import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BrainGraph } from '../src/features/brain/BrainGraph.js';
import {
  ALPHA_MIN,
  buildWikilinkEdges,
  createBrainGraphState,
  stepBrainGraph,
} from '../src/features/brain/brain-graph-model.js';
import type { KnowledgeDocumentDto } from '../src/lib/api-client.js';

const document = (id: string, title: string, content = ''): KnowledgeDocumentDto => ({
  id,
  pageId: id,
  source: `app://${id}`,
  title,
  content,
  chunksCount: 1,
  totalCharacters: content.length,
  updatedAt: 'now',
  isCustom: true,
});

describe('brain graph model', () => {
  it('includes saved Azure links, deduplicates reverse and Markdown links, and ignores missing documents', () => {
    const azure = {
      ...document('42', 'Azure'),
      source: 'https://dev.azure.com/wiki',
      isCustom: false,
    };
    const local = document('local', 'Local', '[[Azure]]');
    const other = document('43', 'Other Azure');
    const state = createBrainGraphState(
      [azure, local, other],
      [
        { sourcePageId: '42', targetPageId: 'local' },
        { sourcePageId: 'local', targetPageId: '42' },
        { sourcePageId: '42', targetPageId: '43' },
        { sourcePageId: '42', targetPageId: 'missing' },
        { sourcePageId: '42', targetPageId: '42' },
      ],
    );
    expect(state.edges).toHaveLength(2);
    expect(state.edges).toContainEqual({
      sourcePageId: '42',
      targetPageId: '43',
      sourceIndex: 1,
      targetIndex: 3,
    });
  });

  it('builds one edge for valid, unique wikilinks and creates indexed state', () => {
    const first = document('first', 'First', '[[Second]] [[missing]] [[First]] [[second|alias]]');
    const second = document('second', 'Second', '[[First]]');

    expect(buildWikilinkEdges([first, second])).toEqual([
      { sourcePageId: 'second', targetPageId: 'first' },
    ]);
    expect(buildWikilinkEdges([{ ...first, content: undefined }])).toEqual([]);
    const state = createBrainGraphState([first, second]);
    expect(state.nodes).toHaveLength(3);
    expect(state.edges).toEqual([
      { sourcePageId: 'second', targetPageId: 'first', sourceIndex: 2, targetIndex: 1 },
    ]);
  });

  it('sizes nodes by connections and pre-settles the layout without overlap', () => {
    const hub = document('hub', 'Hub', '[[A]] [[B]] [[C]] [[D]]');
    const leaves = ['A', 'B', 'C', 'D'].map((name) => document(name, name));
    const state = createBrainGraphState([hub, ...leaves, document('lonely', 'Lonely')]);
    const byId = new Map(state.nodes.map((node) => [node.id, node]));
    expect(byId.get('hub')!.degree).toBe(4);
    expect(byId.get('hub')!.radius).toBeGreaterThan(byId.get('A')!.radius);
    expect(byId.get('lonely')!.radius).toBe(byId.get('A')!.radius - 1.3);
    expect(state.alpha).toBeLessThan(1);
    expect(state.nodes.every((node) => Number.isFinite(node.x + node.y))).toBe(true);
    const hubNode = byId.get('hub')!;
    const leaf = byId.get('A')!;
    expect(Math.hypot(hubNode.x - leaf.x, hubNode.y - leaf.y)).toBeGreaterThan(20);
  });

  it('cools down, keeps dragged nodes pinned and survives degenerate positions', () => {
    const a = document('a', 'A', '[[B]]');
    const b = document('b', 'B');
    const state = createBrainGraphState([a, b]);
    const [welcome, first, second] = state.nodes;

    // Far apart nodes skip repulsion, coincident linked nodes do not blow up.
    welcome!.x = -5000;
    first!.x = second!.x = 500;
    first!.y = second!.y = 300;
    first!.vx = first!.vy = second!.vx = second!.vy = 0;
    state.dragging = welcome!;
    welcome!.vx = 9;
    expect(stepBrainGraph(state)).toBe(true);
    expect(welcome!.vx).toBe(0);
    expect(welcome!.x).toBe(-5000);
    expect(state.nodes.every((node) => Number.isFinite(node.x + node.y))).toBe(true);

    state.dragging = null;
    state.alphaTarget = 0.3;
    for (let tick = 0; tick < 50; tick += 1) stepBrainGraph(state);
    expect(state.alpha).toBeGreaterThan(0.2);
    state.alphaTarget = 0;
    let ticks = 0;
    while (stepBrainGraph(state)) ticks += 1;
    expect(ticks).toBeGreaterThan(10);
    expect(state.alpha).toBeLessThan(ALPHA_MIN);
  });
});

describe('BrainGraph', () => {
  it('lays out, highlights on hover, drags, pans, zooms and opens documents', () => {
    const context = {
      arc: vi.fn(),
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      fill: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      restore: vi.fn(),
      save: vi.fn(),
      scale: vi.fn(),
      setTransform: vi.fn(),
      stroke: vi.fn(),
      translate: vi.fn(),
      fillStyle: '',
      font: '',
      globalAlpha: 1,
      lineWidth: 1,
      strokeStyle: '',
      textAlign: 'start',
      textBaseline: 'alphabetic',
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    });
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    let clock = 0;
    const flush = (limit = 3000) => {
      for (let count = 0; count < limit && frames.size > 0; count += 1) {
        const [id, callback] = frames.entries().next().value as [number, FrameRequestCallback];
        frames.delete(id);
        clock += 16;
        callback(clock);
      }
    };
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 0 });

    const first = document(
      'first',
      'First document with a deliberately long title that must be truncated',
      '[[Second]]',
    );
    const second = document('second', 'Second');
    const third = document('third', 'Third');
    const onOpenDocument = vi.fn();
    const onOpenWelcome = vi.fn();
    const view = render(
      <BrainGraph
        documents={[first, second, third]}
        onOpenDocument={onOpenDocument}
        onOpenWelcome={onOpenWelcome}
      />,
    );
    const canvas = view.getByTestId('graph-canvas') as HTMLCanvasElement;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 600,
      right: 1000,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    Object.assign(canvas, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: vi.fn(),
    });
    const pointer = (
      type: string,
      pointerId: number,
      clientX: number,
      clientY: number,
      button = 0,
    ) => {
      const event = new Event(type, { bubbles: true });
      Object.assign(event, { pointerId, clientX, clientY, button });
      return event;
    };
    // The simulation runs on animation frames until it cools down.
    expect(frames.size).toBeGreaterThan(0);
    flush();
    expect(frames.size).toBe(0);

    // Reads node screen positions back from the last painted frame.
    const nodePositions = () => {
      fireEvent.click(view.getByTestId('graph-zoom-in'));
      const [tx, ty] = vi.mocked(context.translate).mock.calls.at(-1)!;
      const [scale] = vi.mocked(context.scale).mock.calls.at(-1)!;
      return vi
        .mocked(context.arc)
        .mock.calls.slice(-4)
        .map(([x, y]) => ({ x: tx + x * scale, y: ty + y * scale }));
    };
    const [welcomeAt, firstAt, secondAt] = nodePositions();
    expect(
      vi.mocked(context.fillText).mock.calls.some(([text]) => String(text).endsWith('…')),
    ).toBe(true);

    // Hovering focuses a node and its neighbours; leaving restores the graph.
    vi.mocked(context.stroke).mockClear();
    fireEvent(canvas, pointer('pointermove', 5, firstAt!.x, firstAt!.y));
    expect(canvas.style.cursor).toBe('pointer');
    expect(context.stroke).toHaveBeenCalledTimes(2);
    fireEvent(canvas, pointer('pointermove', 5, firstAt!.x, firstAt!.y));
    expect(context.stroke).toHaveBeenCalledTimes(2);
    fireEvent(canvas, pointer('pointermove', 5, secondAt!.x, secondAt!.y));
    fireEvent(canvas, pointer('pointermove', 5, 3, 3));
    expect(canvas.style.cursor).toBe('');

    // Clicks open documents / the welcome note; a tiny jitter still counts as a click.
    fireEvent(canvas, pointer('pointerdown', 1, welcomeAt!.x, welcomeAt!.y, 2));
    fireEvent(canvas, pointer('pointerdown', 1, welcomeAt!.x, welcomeAt!.y));
    fireEvent(canvas, pointer('pointerup', 1, welcomeAt!.x, welcomeAt!.y));
    expect(onOpenWelcome).toHaveBeenCalledOnce();
    fireEvent(canvas, pointer('pointerdown', 1, firstAt!.x, firstAt!.y));
    fireEvent(canvas, pointer('pointermove', 1, firstAt!.x + 1, firstAt!.y));
    fireEvent(canvas, pointer('pointerup', 1, firstAt!.x + 1, firstAt!.y));
    expect(onOpenDocument).toHaveBeenCalledWith(first);
    fireEvent(canvas, pointer('pointerup', 1, 0, 0));

    // Dragging reheats the layout; releasing lets it settle without opening the note.
    fireEvent(canvas, pointer('pointerdown', 2, secondAt!.x, secondAt!.y));
    fireEvent(canvas, pointer('pointermove', 99, 400, 400));
    fireEvent(canvas, pointer('pointermove', 2, secondAt!.x + 120, secondAt!.y + 80));
    expect(frames.size).toBeGreaterThan(0);
    fireEvent(canvas, pointer('pointermove', 2, secondAt!.x + 140, secondAt!.y + 90));
    for (let index = 0; index < 5; index += 1) flush(1);
    fireEvent(canvas, pointer('pointerup', 2, secondAt!.x + 140, secondAt!.y + 90));
    flush();
    expect(onOpenDocument).toHaveBeenCalledTimes(1);

    // A cancelled drag, and a cancelled press without moving, never open anything.
    const [, , movedSecond] = nodePositions();
    fireEvent(canvas, pointer('pointerdown', 3, movedSecond!.x, movedSecond!.y));
    fireEvent(canvas, pointer('pointermove', 3, movedSecond!.x + 30, movedSecond!.y + 30));
    fireEvent(canvas, pointer('pointercancel', 3, 0, 0));
    flush();
    fireEvent(canvas, pointer('pointerdown', 4, welcomeAt!.x, welcomeAt!.y));
    fireEvent(canvas, pointer('pointercancel', 4, 0, 0));
    flush();
    expect(onOpenDocument).toHaveBeenCalledTimes(1);
    expect(onOpenWelcome).toHaveBeenCalledTimes(1);
    Object.assign(canvas, { hasPointerCapture: () => false });
    fireEvent(canvas, pointer('pointerdown', 5, 3, 3));
    fireEvent(canvas, pointer('pointerup', 5, 3, 3));

    // Pan, wheel zoom, buttons and recentering.
    fireEvent(canvas, pointer('pointerdown', 6, 3, 3));
    fireEvent(canvas, pointer('pointermove', 6, 60, 40));
    fireEvent(canvas, pointer('pointerup', 6, 60, 40));
    fireEvent.wheel(canvas, { deltaY: -100, clientX: 400, clientY: 200 });
    fireEvent.wheel(canvas, { deltaY: 100, clientX: 400, clientY: 200 });
    fireEvent.click(view.getByTestId('graph-zoom-out'));
    fireEvent.click(view.getByTestId('graph-zoom-in'));
    expect(view.getByTestId('graph-zoom-reset')).toHaveTextContent('%');
    fireEvent.click(view.getByTestId('graph-zoom-reset'));
    fireEvent.click(view.getByTestId('center-graph'));
    flush();
    fireEvent.click(view.getByTestId('center-graph'));
    fireEvent(canvas, pointer('pointerdown', 7, 3, 3));
    fireEvent(canvas, pointer('pointerup', 7, 3, 3));
    flush();

    fireEvent.wheel(canvas, { deltaY: 5000, clientX: 400, clientY: 200 });
    fireEvent.click(view.getByTestId('graph-node-welcome'));
    fireEvent.click(view.getByTestId('graph-node-second'));
    expect(onOpenWelcome).toHaveBeenCalledTimes(2);
    expect(onOpenDocument).toHaveBeenCalledWith(second);

    view.rerender(
      <BrainGraph
        documents={[second]}
        onOpenDocument={onOpenDocument}
        onOpenWelcome={onOpenWelcome}
      />,
    );
    view.rerender(
      <BrainGraph
        documents={[third]}
        onOpenDocument={onOpenDocument}
        onOpenWelcome={onOpenWelcome}
      />,
    );
    flush();
    view.unmount();
    expect(cancelFrame).toHaveBeenCalled();
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
  });
});
