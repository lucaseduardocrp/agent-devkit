import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { KnowledgeDocumentDto } from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';
import { Button } from '../../components/ui/button.js';
import {
  createBrainGraphState,
  DRAG_ALPHA_TARGET,
  GRAPH_HEIGHT,
  GRAPH_WIDTH,
  stepBrainGraph,
  type BrainGraphNode,
  type BrainGraphEdge,
  type BrainGraphState,
} from './brain-graph-model.js';

interface BrainGraphProps {
  readonly documents: readonly KnowledgeDocumentDto[];
  readonly relations?: readonly BrainGraphEdge[];
  readonly onOpenDocument: (document: KnowledgeDocumentDto) => void;
  readonly onOpenWelcome: () => void;
}

interface GraphViewport {
  width: number;
  height: number;
  pixelRatio: number;
}

interface GraphCamera {
  x: number;
  y: number;
  scale: number;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 6;
const MAX_FIT_ZOOM = 1.5;
const ZOOM_STEP = 1.2;
const WHEEL_ZOOM_SPEED = 0.0015;
const DRAG_THRESHOLD = 3;

// Obsidian dark-theme graph palette.
const EDGE_COLOR = 'rgba(255, 255, 255, 0.16)';
const EDGE_DIM_COLOR = 'rgba(255, 255, 255, 0.05)';
const NODE_COLOR = '#b3b3b3';
const NEIGHBOR_COLOR = '#e4e4e4';
const ACCENT_COLOR = '#8b6cf6';
const LABEL_COLOR = '#dadada';

type GraphPointerInteraction =
  | {
      readonly kind: 'node';
      readonly pointerId: number;
      readonly node: BrainGraphNode;
      readonly startX: number;
      readonly startY: number;
      moved: boolean;
    }
  | {
      readonly kind: 'camera';
      readonly pointerId: number;
      readonly startClientX: number;
      readonly startClientY: number;
      readonly startCameraX: number;
      readonly startCameraY: number;
    };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function centeredCamera(nodes: readonly BrainGraphNode[], viewport: GraphViewport): GraphCamera {
  const minX = Math.min(...nodes.map((node) => node.x));
  const maxX = Math.max(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxY = Math.max(...nodes.map((node) => node.y));
  const contentWidth = Math.max(maxX - minX, 1);
  const contentHeight = Math.max(maxY - minY, 1);
  const scale = clamp(
    Math.min((viewport.width - 160) / contentWidth, (viewport.height - 140) / contentHeight),
    MIN_ZOOM,
    MAX_FIT_ZOOM,
  );
  return {
    x: viewport.width / 2 - ((minX + maxX) / 2) * scale,
    y: viewport.height / 2 - ((minY + maxY) / 2) * scale,
    scale,
  };
}

function drawBrainGraph(
  context: CanvasRenderingContext2D,
  state: BrainGraphState,
  viewport: GraphViewport,
  camera: GraphCamera,
): void {
  context.setTransform(viewport.pixelRatio, 0, 0, viewport.pixelRatio, 0, 0);
  context.clearRect(0, 0, viewport.width, viewport.height);
  // No fill: the canvas is transparent and the container paints --graph-bg.
  context.save();
  context.translate(camera.x, camera.y);
  context.scale(camera.scale, camera.scale);

  const { hoveredId } = state;
  const hasFocus = hoveredId !== null;
  const related = new Set<string>();
  if (hasFocus) {
    related.add(hoveredId);
    for (const edge of state.edges) {
      if (edge.sourcePageId === hoveredId) related.add(edge.targetPageId);
      if (edge.targetPageId === hoveredId) related.add(edge.sourcePageId);
    }
  }

  // Edges are batched into two paths: the regular ones (dimmed while hovering) and the focused ones.
  const strokeEdges = (focused: boolean, color: string, width: number) => {
    context.beginPath();
    for (const edge of state.edges) {
      const touchesHover = edge.sourcePageId === hoveredId || edge.targetPageId === hoveredId;
      if (touchesHover !== focused) continue;
      const source = state.nodes[edge.sourceIndex]!;
      const target = state.nodes[edge.targetIndex]!;
      context.moveTo(source.x, source.y);
      context.lineTo(target.x, target.y);
    }
    context.strokeStyle = color;
    context.lineWidth = width / camera.scale;
    context.stroke();
  };
  context.globalAlpha = 1;
  strokeEdges(false, hasFocus ? EDGE_DIM_COLOR : EDGE_COLOR, 1);
  if (hasFocus) strokeEdges(true, ACCENT_COLOR, 1.5);

  for (const node of state.nodes) {
    const isHovered = node.id === hoveredId;
    const isRelated = !hasFocus || related.has(node.id);
    context.globalAlpha = isRelated ? 1 : 0.25;
    context.beginPath();
    context.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
    context.fillStyle = isHovered ? ACCENT_COLOR : hasFocus ? NEIGHBOR_COLOR : NODE_COLOR;
    context.fill();
  }

  // Labels fade in with zoom (bigger nodes earlier) and stay pinned for the hovered neighbourhood.
  context.font = `${12 / camera.scale}px Inter, system-ui, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'top';
  context.fillStyle = LABEL_COLOR;
  for (const node of state.nodes) {
    const zoomFade = clamp((camera.scale + node.radius * 0.02 - 0.55) / 0.6, 0, 1);
    const emphasized = hasFocus && related.has(node.id);
    const opacity = (emphasized ? 1 : zoomFade) * (!hasFocus || emphasized ? 1 : 0.25);
    if (opacity < 0.02) continue;
    context.globalAlpha = opacity * 0.9;
    const label = node.label.length > 30 ? `${node.label.slice(0, 28)}…` : node.label;
    context.fillText(label, node.x, node.y + node.radius + 3 / camera.scale);
  }
  context.globalAlpha = 1;
  context.restore();
}

function findNode(
  nodes: readonly BrainGraphNode[],
  x: number,
  y: number,
  scale: number,
): BrainGraphNode | null {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]!;
    if (Math.hypot(x - node.x, y - node.y) < node.radius + 4 / scale) return node;
  }
  return null;
}

export function BrainGraph({
  documents,
  relations,
  onOpenDocument,
  onOpenWelcome,
}: BrainGraphProps) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const graphState = useMemo(
    () => createBrainGraphState(documents, relations),
    [documents, relations],
  );
  const stateRef = useRef<BrainGraphState>(graphState);
  const viewportRef = useRef<GraphViewport>({
    width: GRAPH_WIDTH,
    height: GRAPH_HEIGHT,
    pixelRatio: 1,
  });
  const cameraRef = useRef<GraphCamera>(
    centeredCamera(stateRef.current.nodes, viewportRef.current),
  );
  const interactionRef = useRef<GraphPointerInteraction | null>(null);
  const physicsFrameRef = useRef<number | null>(null);
  const cameraFrameRef = useRef<number | null>(null);
  const [zoomPercent, setZoomPercent] = useState(() => Math.round(cameraRef.current.scale * 100));

  const updateZoomLabel = useCallback(() => {
    setZoomPercent(Math.round(cameraRef.current.scale * 100));
  }, []);

  const draw = useCallback(() => {
    const context = canvasRef.current?.getContext('2d');
    if (context) drawBrainGraph(context, stateRef.current, viewportRef.current, cameraRef.current);
  }, []);

  const stopPhysics = useCallback(() => {
    if (physicsFrameRef.current !== null) {
      cancelAnimationFrame(physicsFrameRef.current);
      physicsFrameRef.current = null;
    }
  }, []);

  const stopCameraAnimation = useCallback(() => {
    if (cameraFrameRef.current !== null) {
      cancelAnimationFrame(cameraFrameRef.current);
      cameraFrameRef.current = null;
    }
  }, []);

  // The simulation keeps ticking until it cools down (or while a node is being dragged).
  const animatePhysics = useCallback(() => {
    const active = stepBrainGraph(stateRef.current);
    draw();
    physicsFrameRef.current = active ? requestAnimationFrame(animatePhysics) : null;
  }, [draw]);

  const startPhysics = useCallback(() => {
    if (physicsFrameRef.current === null) {
      physicsFrameRef.current = requestAnimationFrame(animatePhysics);
    }
  }, [animatePhysics]);

  const centerGraph = useCallback(
    (animated: boolean) => {
      stopCameraAnimation();
      const target = centeredCamera(stateRef.current.nodes, viewportRef.current);
      if (!animated) {
        cameraRef.current = target;
        updateZoomLabel();
        draw();
        return;
      }
      const start = { ...cameraRef.current };
      let startTime: number | null = null;
      const animateCamera = (timestamp: number) => {
        startTime ??= timestamp;
        const progress = Math.min(1, (timestamp - startTime) / 280);
        const eased = 1 - Math.pow(1 - progress, 3);
        cameraRef.current = {
          x: start.x + (target.x - start.x) * eased,
          y: start.y + (target.y - start.y) * eased,
          scale: start.scale + (target.scale - start.scale) * eased,
        };
        updateZoomLabel();
        draw();
        if (progress < 1) cameraFrameRef.current = requestAnimationFrame(animateCamera);
        else cameraFrameRef.current = null;
      };
      cameraFrameRef.current = requestAnimationFrame(animateCamera);
    },
    [draw, stopCameraAnimation, updateZoomLabel],
  );

  const zoomAt = useCallback(
    (factor: number, x = viewportRef.current.width / 2, y = viewportRef.current.height / 2) => {
      stopCameraAnimation();
      const camera = cameraRef.current;
      const nextScale = clamp(camera.scale * factor, MIN_ZOOM, MAX_ZOOM);
      const worldX = (x - camera.x) / camera.scale;
      const worldY = (y - camera.y) / camera.scale;
      cameraRef.current = {
        x: x - worldX * nextScale,
        y: y - worldY * nextScale,
        scale: nextScale,
      };
      updateZoomLabel();
      draw();
    },
    [draw, stopCameraAnimation, updateZoomLabel],
  );

  useEffect(() => {
    stopPhysics();
    interactionRef.current = null;
    stateRef.current = graphState;
    centerGraph(false);
    startPhysics();
  }, [graphState, centerGraph, startPhysics, stopPhysics]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const resizeCanvas = () => {
      const bounds = canvas.getBoundingClientRect();
      const previous = viewportRef.current;
      const viewport = {
        width: bounds.width || GRAPH_WIDTH,
        height: bounds.height || GRAPH_HEIGHT,
        pixelRatio: Math.max(1, window.devicePixelRatio || 1),
      };
      canvas.width = Math.round(viewport.width * viewport.pixelRatio);
      canvas.height = Math.round(viewport.height * viewport.pixelRatio);
      cameraRef.current.x += (viewport.width - previous.width) / 2;
      cameraRef.current.y += (viewport.height - previous.height) / 2;
      viewportRef.current = viewport;
      draw();
    };
    resizeCanvas();
    const observer = new ResizeObserver(resizeCanvas);
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      stopPhysics();
      stopCameraAnimation();
    };
  }, [draw, stopCameraAnimation, stopPhysics]);

  const screenPoint = (event: {
    readonly currentTarget: HTMLCanvasElement;
    readonly clientX: number;
    readonly clientY: number;
  }) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };

  const worldPoint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = screenPoint(event);
    const camera = cameraRef.current;
    return { x: (point.x - camera.x) / camera.scale, y: (point.y - camera.y) / camera.scale };
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    stopCameraAnimation();
    const point = worldPoint(event);
    const node = findNode(stateRef.current.nodes, point.x, point.y, cameraRef.current.scale);
    if (node) {
      stateRef.current.dragging = node;
      interactionRef.current = {
        kind: 'node',
        pointerId: event.pointerId,
        node,
        startX: point.x,
        startY: point.y,
        moved: false,
      };
    } else {
      interactionRef.current = {
        kind: 'camera',
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startCameraX: cameraRef.current.x,
        startCameraY: cameraRef.current.y,
      };
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const interaction = interactionRef.current;
    if (interaction?.pointerId === event.pointerId) {
      if (interaction.kind === 'node') {
        const point = worldPoint(event);
        if (
          !interaction.moved &&
          Math.hypot(point.x - interaction.startX, point.y - interaction.startY) *
            cameraRef.current.scale >
            DRAG_THRESHOLD
        ) {
          // Obsidian reheats the layout as soon as a node is actually dragged.
          interaction.moved = true;
          stateRef.current.alphaTarget = DRAG_ALPHA_TARGET;
          startPhysics();
        }
        if (interaction.moved) {
          interaction.node.x = point.x;
          interaction.node.y = point.y;
        }
      } else {
        cameraRef.current.x = interaction.startCameraX + event.clientX - interaction.startClientX;
        cameraRef.current.y = interaction.startCameraY + event.clientY - interaction.startClientY;
      }
      draw();
      return;
    }
    const point = worldPoint(event);
    const hoveredId =
      findNode(stateRef.current.nodes, point.x, point.y, cameraRef.current.scale)?.id ?? null;
    if (hoveredId !== stateRef.current.hoveredId) {
      stateRef.current.hoveredId = hoveredId;
      event.currentTarget.style.cursor = hoveredId ? 'pointer' : '';
      draw();
    }
  };

  const finishPointerInteraction = (
    event: ReactPointerEvent<HTMLCanvasElement>,
    allowOpen: boolean,
  ) => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    interactionRef.current = null;
    if (interaction.kind === 'node') {
      stateRef.current.dragging = null;
      stateRef.current.alphaTarget = 0;
      if (allowOpen && !interaction.moved) {
        if (interaction.node.document) onOpenDocument(interaction.node.document);
        else onOpenWelcome();
      } else {
        // Released nodes are free again and the layout settles on its own.
        startPhysics();
      }
    }
    draw();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-[var(--graph-bg)]"
      data-testid="graph-view"
    >
      <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
        <div className="flex items-center rounded-md border border-[var(--border-strong)] bg-[var(--graph-control-bg)] p-0.5 shadow-md">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-[var(--text-secondary)]"
            onClick={() => zoomAt(1 / ZOOM_STEP)}
            disabled={cameraRef.current.scale <= MIN_ZOOM}
            aria-label={t('brain.zoomOut')}
            title={t('brain.zoomOut')}
            data-testid="graph-zoom-out"
          >
            <i className="ti ti-minus" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 min-w-14 px-2 text-[11px] text-[var(--text-secondary)]"
            onClick={() => centerGraph(true)}
            aria-label={t('brain.resetZoom')}
            title={t('brain.resetZoom')}
            data-testid="graph-zoom-reset"
          >
            {zoomPercent}%
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-[var(--text-secondary)]"
            onClick={() => zoomAt(ZOOM_STEP)}
            disabled={cameraRef.current.scale >= MAX_ZOOM}
            aria-label={t('brain.zoomIn')}
            title={t('brain.zoomIn')}
            data-testid="graph-zoom-in"
          >
            <i className="ti ti-plus" aria-hidden="true" />
          </Button>
        </div>
        <button
          type="button"
          onClick={() => centerGraph(true)}
          className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--border-strong)] bg-[var(--graph-control-bg)] px-2.5 text-xs font-medium text-[var(--text-secondary)] shadow-md transition-colors hover:border-[var(--border-accent)] hover:bg-[var(--surface-1)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-accent)]"
          data-testid="center-graph"
          aria-label={t('brain.centerGraph')}
          title={t('brain.centerGraph')}
        >
          <i className="ti ti-focus-centered" aria-hidden="true" />
          <span>{t('brain.centerGraph')}</span>
        </button>
        <div className="rounded-md border border-[var(--border)] bg-[var(--graph-control-bg)] px-3 py-1.5 text-xs text-[var(--text-muted)] shadow-md">
          {t('brain.graphStats', {
            notes: documents.length,
            connections: graphState.edges.length,
          })}
        </div>
      </div>
      <canvas
        ref={canvasRef}
        className="block h-full w-full cursor-grab active:cursor-grabbing"
        style={{ touchAction: 'none' }}
        data-testid="graph-canvas"
        aria-label={t('brain.graphAriaLabel')}
        role="img"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => finishPointerInteraction(event, true)}
        onPointerCancel={(event) => finishPointerInteraction(event, false)}
        onWheel={(event) => {
          event.preventDefault();
          const point = screenPoint(event);
          zoomAt(Math.exp(-event.deltaY * WHEEL_ZOOM_SPEED), point.x, point.y);
        }}
      />
      <div className="sr-only">
        <button type="button" onClick={onOpenWelcome} data-testid="graph-node-welcome">
          {t('brain.welcome')}
        </button>
        {documents.map((document) => (
          <button
            type="button"
            key={document.id}
            onClick={() => onOpenDocument(document)}
            data-testid={`graph-node-${document.id}`}
          >
            {document.title}
          </button>
        ))}
      </div>
    </div>
  );
}
