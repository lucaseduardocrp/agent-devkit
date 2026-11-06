import React, { useCallback, useRef, useState } from 'react';
import { cn } from '../../lib/utils.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { useI18n } from '../../lib/i18n/index.js';
import {
  canConnect,
  edgeMidpoint,
  edgePath,
  findNode,
  inputPort,
  nodePorts,
  nodeProblem,
  nodeSize,
  outputPort,
  WORKFLOW_TRIGGER_NODE_ID,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowPoint,
  type WorkflowPort,
} from './workflow-graph.js';

/** What a node shows: the chip over its icon, its two lines of text and its accent colour. */
export interface WorkflowNodeView {
  readonly icon: string;
  readonly iconClassName: string;
  readonly kicker: string;
  readonly title: string;
  readonly subtitle: string;
}

/** Where a run is on a node, when the canvas shows a run instead of editing a flow. */
export type WorkflowRunState = 'done' | 'current' | 'waiting' | 'pending';

export interface AgentWorkflowCanvasProps {
  /** Marks each node with the progress of a run; nodes missing from it render as usual. */
  readonly nodeStates?: Readonly<Record<string, WorkflowRunState>>;
  readonly canvasClassName?: string;
  readonly graph: WorkflowGraph;
  readonly isReadOnly: boolean;
  /** Dims the whole canvas while the workflow is turned off. */
  readonly isDimmed: boolean;
  readonly selectedNodeId: string | null;
  readonly describeNode: (node: WorkflowNode) => WorkflowNodeView;
  readonly onOpenNode: (id: string) => void;
  readonly onMoveNode: (id: string, x: number, y: number) => void;
  readonly onRemoveNode: (id: string) => void;
  readonly onConnect: (from: string, to: string, port?: WorkflowPort) => void;
  readonly onDisconnect: (edgeId: string) => void;
}

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 1.6;
const ZOOM_STEP = 0.15;
/** Pointer travel, in pixels, that turns a click on a node into a drag. */
const DRAG_THRESHOLD = 3;

interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

const INITIAL_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

type Gesture =
  | { readonly kind: 'pan'; readonly pointerX: number; readonly pointerY: number }
  | {
      readonly kind: 'node';
      readonly id: string;
      readonly offsetX: number;
      readonly offsetY: number;
      readonly moved: boolean;
    }
  | { readonly kind: 'link'; readonly from: string; readonly port?: WorkflowPort };

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(zoom.toFixed(2))));
}

/** The node id of the element under the pointer, so a connection can be dropped anywhere on it. */
function nodeIdAt(target: EventTarget): string | null {
  return (target as Element).closest('[data-node-id]')?.getAttribute('data-node-id') ?? null;
}

/**
 * The flow as a free canvas: nodes sit where they were dropped, every node can be wired to as many
 * others as the flow needs, and an approval node is just another node on a connection.
 */
export function AgentWorkflowCanvas({
  nodeStates,
  canvasClassName,
  graph,
  isReadOnly,
  isDimmed,
  selectedNodeId,
  describeNode,
  onOpenNode,
  onMoveNode,
  onRemoveNode,
  onConnect,
  onDisconnect,
}: AgentWorkflowCanvasProps): React.JSX.Element {
  const { t } = useI18n();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<Viewport>(INITIAL_VIEWPORT);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [pointer, setPointer] = useState<WorkflowPoint>({ x: 0, y: 0 });

  /** Client coordinates translated into the canvas space the nodes are positioned in. */
  const toCanvas = useCallback(
    (clientX: number, clientY: number): WorkflowPoint => {
      // Only ever called from a pointer handler of the surface, so the ref is set.
      const rect = surfaceRef.current!.getBoundingClientRect();
      return {
        x: (clientX - rect.left - viewport.x) / viewport.zoom,
        y: (clientY - rect.top - viewport.y) / viewport.zoom,
      };
    },
    [viewport],
  );

  const zoomBy = (delta: number) =>
    setViewport((current) => ({ ...current, zoom: clampZoom(current.zoom + delta) }));

  const resetView = () => setViewport(INITIAL_VIEWPORT);

  const startPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (nodeIdAt(event.target)) return;
    setGesture({ kind: 'pan', pointerX: event.clientX, pointerY: event.clientY });
  };

  const startNodeDrag = (event: React.PointerEvent<HTMLDivElement>, node: WorkflowNode) => {
    if (isReadOnly) return;
    event.stopPropagation();
    const position = toCanvas(event.clientX, event.clientY);
    setGesture({
      kind: 'node',
      id: node.id,
      offsetX: position.x - node.x,
      offsetY: position.y - node.y,
      moved: false,
    });
  };

  /** Only reachable while the port is enabled, which read-only mode takes care of. */
  const startLink = (
    event: React.PointerEvent<HTMLButtonElement>,
    node: WorkflowNode,
    port?: WorkflowPort,
  ) => {
    event.stopPropagation();
    setPointer(toCanvas(event.clientX, event.clientY));
    setGesture({ kind: 'link', from: node.id, ...(port ? { port } : {}) });
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!gesture) return;
    if (gesture.kind === 'pan') {
      const deltaX = event.clientX - gesture.pointerX;
      const deltaY = event.clientY - gesture.pointerY;
      setViewport((current) => ({ ...current, x: current.x + deltaX, y: current.y + deltaY }));
      setGesture({ kind: 'pan', pointerX: event.clientX, pointerY: event.clientY });
      return;
    }
    if (gesture.kind === 'link') {
      setPointer(toCanvas(event.clientX, event.clientY));
      return;
    }
    const position = toCanvas(event.clientX, event.clientY);
    const node = findNode(graph, gesture.id);
    const nextX = position.x - gesture.offsetX;
    const nextY = position.y - gesture.offsetY;
    if (
      !gesture.moved &&
      node &&
      Math.abs(nextX - node.x) < DRAG_THRESHOLD &&
      Math.abs(nextY - node.y) < DRAG_THRESHOLD
    )
      return;
    setGesture({ ...gesture, moved: true });
    onMoveNode(gesture.id, nextX, nextY);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!gesture) return;
    if (gesture.kind === 'link') {
      const target = nodeIdAt(event.target);
      if (target && canConnect(graph, gesture.from, target, gesture.port))
        onConnect(gesture.from, target, gesture.port);
    } else if (gesture.kind === 'node' && !gesture.moved) {
      onOpenNode(gesture.id);
    }
    setGesture(null);
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey) return;
    zoomBy(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
  };

  // Both endpoints of an edge exist: the graph handed in is always a normalized one.
  const drawnEdges: readonly {
    readonly edge: WorkflowEdge;
    readonly from: WorkflowPoint;
    readonly to: WorkflowPoint;
  }[] = graph.edges.map((edge) => ({
    edge,
    from: outputPort(findNode(graph, edge.from)!, edge.fromPort),
    to: inputPort(findNode(graph, edge.to)!),
  }));

  const linkPreview =
    gesture?.kind === 'link'
      ? { from: outputPort(findNode(graph, gesture.from)!, gesture.port), to: pointer }
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 border-b border-[var(--border)] bg-[var(--surface-2)] px-4 py-3">
        <span className="text-sm font-semibold text-[var(--text-primary)]">
          {t('agents.workflowFlow')}
        </span>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[var(--text-muted)]">
          <span>{t('agents.workflowCanvasHint')}</span>
          <div className="flex items-center gap-1">
            <IconButton
              variant="subtle"
              size="sm"
              icon={<i className="ti ti-minus" aria-hidden="true" />}
              label={t('agents.workflowZoomOut')}
              onClick={() => zoomBy(-ZOOM_STEP)}
              data-testid="workflow-zoom-out"
            />
            <span
              className="min-w-[46px] text-center font-mono text-[11px] text-[var(--text-secondary)]"
              data-testid="workflow-zoom-level"
            >
              {`${Math.round(viewport.zoom * 100)}%`}
            </span>
            <IconButton
              variant="subtle"
              size="sm"
              icon={<i className="ti ti-plus" aria-hidden="true" />}
              label={t('agents.workflowZoomIn')}
              onClick={() => zoomBy(ZOOM_STEP)}
              data-testid="workflow-zoom-in"
            />
            <IconButton
              variant="subtle"
              size="sm"
              icon={<i className="ti ti-focus-centered" aria-hidden="true" />}
              label={t('agents.workflowResetView')}
              onClick={resetView}
              data-testid="workflow-reset-view"
            />
          </div>
        </div>
      </div>

      <div
        ref={surfaceRef}
        role="application"
        aria-label={t('agents.workflowFlow')}
        data-testid="workflow-canvas"
        onPointerDown={startPan}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={() => setGesture(null)}
        onWheel={handleWheel}
        className={cn(
          // The canvas sits darker than its nodes, so a node reads as a card lifted off it.
          'relative h-[560px] touch-none select-none overflow-hidden bg-[var(--surface-0)] [background-image:radial-gradient(var(--border-strong)_1px,transparent_1px)] [background-size:20px_20px] transition-opacity',
          gesture?.kind === 'pan' ? 'cursor-grabbing' : 'cursor-grab',
          // Turned off reads as muted, not as unreadable: the flow still has to be editable.
          isDimmed && 'opacity-[0.78]',
          canvasClassName,
        )}
      >
        <div
          className="absolute left-0 top-0 h-px w-px"
          style={{
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
            transformOrigin: '0 0',
          }}
        >
          <svg
            className="pointer-events-none absolute left-0 top-0 overflow-visible"
            width="1"
            height="1"
            aria-hidden="true"
          >
            {drawnEdges.map(({ edge, from, to }) => {
              const middle = edgeMidpoint(from, to);
              return (
                <g key={edge.id} className="group">
                  <path
                    d={edgePath(from, to)}
                    fill="none"
                    stroke="var(--text-muted)"
                    strokeWidth={2}
                    className="transition-[stroke] group-hover:stroke-[var(--fill-accent)]"
                  />
                  <path
                    d={edgePath(from, to)}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={18}
                    className="pointer-events-auto"
                  />
                  {!isReadOnly && (
                    <foreignObject
                      x={middle.x - 11}
                      y={middle.y - 11}
                      width={22}
                      height={22}
                      className="pointer-events-auto opacity-0 transition-opacity group-hover:opacity-100 [&:focus-within]:opacity-100"
                    >
                      <IconButton
                        variant="subtle"
                        size="xs"
                        icon={<i className="ti ti-x" aria-hidden="true" />}
                        label={t('agents.workflowRemoveConnection')}
                        onClick={() => onDisconnect(edge.id)}
                        data-testid={`workflow-edge-remove-${edge.id}`}
                        className="h-[22px] w-[22px] rounded-full"
                      />
                    </foreignObject>
                  )}
                </g>
              );
            })}
            {linkPreview && (
              <path
                d={edgePath(linkPreview.from, linkPreview.to)}
                fill="none"
                stroke="var(--fill-accent)"
                strokeWidth={2}
                strokeDasharray="6 5"
                data-testid="workflow-link-preview"
              />
            )}
          </svg>

          {graph.nodes.map((node) => {
            const size = nodeSize(node.kind);
            const view = describeNode(node);
            const isSelected = selectedNodeId === node.id;
            const isDragging = gesture?.kind === 'node' && gesture.id === node.id;
            const problem = nodeProblem(node);
            const runState = nodeStates?.[node.id];
            return (
              <div
                key={node.id}
                data-node-id={node.id}
                data-testid={`workflow-node-${node.id}`}
                onPointerDown={(event) => startNodeDrag(event, node)}
                style={{ left: node.x, top: node.y, width: size.width, height: size.height }}
                className={cn(
                  'group absolute flex items-center gap-3 border-[1.5px] bg-[var(--surface-2)] p-4 text-left shadow-md transition-colors',
                  node.kind === 'trigger' ? 'rounded-l-[36px] rounded-r-2xl' : 'rounded-2xl',
                  !isReadOnly && 'cursor-grab active:cursor-grabbing',
                  isDragging && 'shadow-lg',
                  runState === 'current' &&
                    'border-[var(--fill-accent)] ring-4 ring-[var(--fill-accent)]/25',
                  runState === 'waiting' && 'border-sky-400 ring-4 ring-sky-400/20',
                  runState === 'done' && 'border-emerald-500/60',
                  runState === 'pending' && 'opacity-60',
                  runState
                    ? ''
                    : isSelected
                      ? 'border-[var(--fill-accent)] ring-4 ring-[var(--fill-accent)]/15'
                      : problem
                        ? 'border-[var(--fill-warning)] hover:border-[var(--fill-accent)]'
                        : 'border-[var(--border-strong)] hover:border-[var(--fill-accent)]',
                )}
              >
                <span
                  className={cn(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
                    view.iconClassName,
                  )}
                >
                  <i className={cn('ti text-lg', view.icon)} aria-hidden="true" />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-mono text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                    {view.kicker}
                  </span>
                  <span className="line-clamp-2 text-sm font-semibold text-[var(--text-primary)]">
                    {view.title}
                  </span>
                  <span
                    className={cn(
                      'truncate text-xs',
                      problem ? 'text-[var(--text-warning)]' : 'text-[var(--text-secondary)]',
                    )}
                  >
                    {problem ? t('agents.workflowNodeIncomplete') : view.subtitle}
                  </span>
                </span>

                {runState && runState !== 'pending' && (
                  <span
                    data-testid={`workflow-node-state-${node.id}`}
                    data-state={runState}
                    aria-hidden="true"
                    className={cn(
                      'absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full border border-[var(--border-strong)] bg-[var(--surface-1)]',
                    )}
                  >
                    <i
                      className={cn(
                        'ti text-sm',
                        runState === 'done' && 'ti-circle-check text-emerald-400',
                        runState === 'current' &&
                          'ti-loader-2 animate-spin text-[var(--fill-accent)]',
                        runState === 'waiting' && 'ti-hourglass text-sky-300',
                      )}
                    />
                  </span>
                )}

                {/* Input port: the drop target of a connection. */}
                {node.kind !== 'trigger' && node.kind !== 'rule' && (
                  <span
                    aria-hidden="true"
                    className="absolute -left-[7px] top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full border-2 border-[var(--text-muted)] bg-[var(--surface-2)]"
                  />
                )}

                {/* Output ports: drag from one to wire this node to another one. */}
                {nodePorts(node).map((port) => {
                  const anchor = outputPort(node, port);
                  return (
                    <button
                      key={port ?? 'out'}
                      type="button"
                      disabled={isReadOnly}
                      onPointerDown={(event) => startLink(event, node, port)}
                      aria-label={
                        port
                          ? t('agents.workflowConnectFromBranch', {
                              name: view.title,
                              branch: t(
                                port === 'true'
                                  ? 'agents.workflowConditionTrue'
                                  : 'agents.workflowConditionFalse',
                              ),
                            })
                          : t('agents.workflowConnectFrom', { name: view.title })
                      }
                      data-testid={`workflow-port-${node.id}${port ? `-${port}` : ''}`}
                      style={{ top: anchor.y - node.y - 9 }}
                      className={cn(
                        'absolute -right-[9px] h-[18px] w-[18px] rounded-full border-2 bg-[var(--surface-2)] transition-colors hover:border-[var(--fill-accent)] hover:bg-[var(--fill-accent)] disabled:cursor-not-allowed disabled:opacity-40',
                        port === 'true'
                          ? 'border-[var(--fill-success)]'
                          : port === 'false'
                            ? 'border-[var(--fill-danger)]'
                            : 'border-[var(--text-muted)]',
                      )}
                    />
                  );
                })}

                {node.id !== WORKFLOW_TRIGGER_NODE_ID && !isReadOnly && (
                  <IconButton
                    variant="subtle"
                    size="xs"
                    icon={<i className="ti ti-x" aria-hidden="true" />}
                    label={t('agents.workflowRemoveNode', { name: view.title })}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => onRemoveNode(node.id)}
                    data-testid={`workflow-node-remove-${node.id}`}
                    className="absolute -right-2 -top-2 rounded-full opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
