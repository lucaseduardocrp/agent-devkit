import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BrainGraph } from '../src/features/brain/BrainGraph.js';
import {
  buildWikilinkEdges,
  createBrainGraphState,
  shouldStopGraphRebound,
  simulateBrainGraph,
  type BrainGraphIndexedEdge,
  type BrainGraphNode,
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

describe('BrainGraph', () => {
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

  it('applies the reference force, speed cap, spring, and boundary bounce', () => {
    const nodes: BrainGraphNode[] = [
      { id: 'a', label: 'A', x: -20, y: -20, vx: -20, vy: -20, radius: 6 },
      { id: 'b', label: 'B', x: 1020, y: 620, vx: 20, vy: 20, radius: 6 },
    ];
    const edges: BrainGraphIndexedEdge[] = [
      { sourceIndex: 0, targetIndex: 1, sourcePageId: 'a', targetPageId: 'b' },
    ];

    simulateBrainGraph(nodes, edges, null);
    expect(nodes[0]!.x).toBe(14);
    expect(nodes[0]!.y).toBe(14);
    expect(nodes[1]!.x).toBe(986);
    expect(nodes[1]!.y).toBe(586);
    simulateBrainGraph(nodes, edges, nodes[0]!);
    simulateBrainGraph(nodes, edges, nodes[1]!);
    simulateBrainGraph(nodes, [{ ...edges[0]!, sourceIndex: 8 }], null);
    expect(nodes.every((node) => Number.isFinite(node.x + node.y))).toBe(true);
    expect(shouldStopGraphRebound(100, 1, 1)).toBe(false);
    expect(shouldStopGraphRebound(180, 0.2, 0.05)).toBe(true);
    expect(shouldStopGraphRebound(700, 1, 1)).toBe(true);
  });

  it('animates dragging, release rebound, camera pan, and centering', () => {
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
      lineWidth: 1,
      strokeStyle: '',
      textAlign: 'start',
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    const requestFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        const id = nextFrameId++;
        frames.set(id, callback);
        return id;
      });
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 0 });
    const first = document('first', 'First document with a deliberately long title', '[[Second]]');
    const second = document('second', 'Second');
    const onOpenDocument = vi.fn();
    const onOpenWelcome = vi.fn();
    const view = render(
      <BrainGraph
        documents={[first, second]}
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
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.assign(canvas, {
      setPointerCapture,
      hasPointerCapture: () => true,
      releasePointerCapture,
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

    fireEvent(canvas, pointer('pointerdown', 9, 500, 300));
    fireEvent(canvas, pointer('pointerup', 9, 500, 300));
    expect(onOpenWelcome).toHaveBeenCalledOnce();
    requestFrame.mockClear();
    cancelFrame.mockClear();
    fireEvent(canvas, pointer('pointermove', 1, 500, 100));
    fireEvent(canvas, pointer('pointermove', 1, 500, 100));
    fireEvent(canvas, pointer('pointermove', 1, 500, 500));
    fireEvent(canvas, pointer('pointermove', 1, 20, 20));
    fireEvent(canvas, pointer('pointerdown', 1, 500, 100, 2));
    fireEvent(canvas, pointer('pointerdown', 1, 20, 20));
    expect(requestFrame).not.toHaveBeenCalled();

    fireEvent(canvas, pointer('pointerdown', 1, 500, 100));
    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(setPointerCapture).toHaveBeenCalledWith(1);
    const firstFrameEntry = frames.entries().next().value as [number, FrameRequestCallback];
    frames.delete(firstFrameEntry[0]);
    const firstFrame = firstFrameEntry[1];
    firstFrame(0);
    expect(requestFrame).toHaveBeenCalledTimes(2);
    const secondFrameEntry = [...frames.entries()].at(-1)!;
    frames.delete(secondFrameEntry[0]);
    secondFrameEntry[1](1);
    const thirdFrameEntry = [...frames.entries()].at(-1)!;
    frames.delete(thirdFrameEntry[0]);
    thirdFrameEntry[1](100);
    const stoppedFrame = [...frames.values()].at(-1)!;
    fireEvent(canvas, pointer('pointermove', 2, 300, 250));
    fireEvent(canvas, pointer('pointerup', 2, 300, 250));
    fireEvent(canvas, pointer('pointermove', 1, 501, 101));
    fireEvent(canvas, pointer('pointermove', 1, 300, 250));
    fireEvent(canvas, pointer('pointerup', 1, 300, 250));
    expect(releasePointerCapture).toHaveBeenCalledWith(1);
    expect(onOpenDocument).not.toHaveBeenCalled();
    const stoppedFrameId = [...frames.entries()].find(
      ([, callback]) => callback === stoppedFrame,
    )![0];
    frames.delete(stoppedFrameId);
    stoppedFrame(116);
    expect(frames.size).toBeGreaterThan(0);
    for (let index = 1; index <= 32 && frames.size > 0; index += 1) {
      const reboundFrame = [...frames.entries()].at(-1)!;
      frames.delete(reboundFrame[0]);
      reboundFrame[1](116 + index * 25);
    }
    expect(frames.size).toBe(0);

    fireEvent(canvas, pointer('pointerdown', 3, 300, 250));
    fireEvent(canvas, pointer('pointerup', 3, 300, 250));
    expect(onOpenDocument).toHaveBeenCalledWith(first);
    fireEvent(canvas, pointer('pointerdown', 4, 300, 250));
    const cancelledDragFrame = [...frames.values()].at(-1)!;
    fireEvent(canvas, pointer('pointercancel', 4, 300, 250));
    cancelledDragFrame(900);
    expect(onOpenDocument).toHaveBeenCalledTimes(1);
    Object.assign(canvas, { hasPointerCapture: () => false });

    fireEvent.click(view.getByTestId('graph-node-welcome'));
    fireEvent.click(view.getByTestId('graph-node-second'));
    expect(onOpenWelcome).toHaveBeenCalledTimes(2);
    expect(onOpenDocument).toHaveBeenCalledWith(second);

    fireEvent(canvas, pointer('pointerdown', 7, 20, 20));
    fireEvent(canvas, pointer('pointermove', 7, 80, 70));
    fireEvent(canvas, pointer('pointerup', 7, 80, 70));
    fireEvent.click(view.getByTestId('center-graph'));
    fireEvent.click(view.getByTestId('graph-zoom-in'));
    expect(view.getByTestId('graph-zoom-reset')).toHaveTextContent('%');
    fireEvent.click(view.getByTestId('graph-zoom-out'));
    fireEvent.wheel(canvas, { deltaY: -100, clientX: 400, clientY: 200 });
    fireEvent.wheel(canvas, { deltaY: 100, clientX: 400, clientY: 200 });
    fireEvent.click(view.getByTestId('graph-zoom-reset'));
    const runLatestFrame = (timestamp: number) => {
      const entry = [...frames.entries()].at(-1)!;
      frames.delete(entry[0]);
      entry[1](timestamp);
    };
    runLatestFrame(0);
    runLatestFrame(140);
    runLatestFrame(280);
    fireEvent(canvas, pointer('pointerdown', 8, 20, 20));
    fireEvent(canvas, pointer('pointermove', 8, 40, 40));
    fireEvent(canvas, pointer('pointerup', 8, 40, 40));
    fireEvent.click(view.getByTestId('center-graph'));
    view.unmount();
    expect(cancelFrame).toHaveBeenCalled();
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
  });
});
