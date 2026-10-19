import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { KnowledgeDocumentDto } from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';
import { Button } from '../../components/ui/button.js';
import {
  createBrainGraphState,
  GRAPH_HEIGHT,
  GRAPH_WIDTH,
  shouldStopGraphRebound,
  simulateBrainGraph,
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

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 1.2;

type GraphPointerInteraction =
  | {
      readonly kind: 'node';
      readonly pointerId: number;
      readonly node: BrainGraphNode;
      readonly startX: number;
      readonly startY: number;
      moved: boolean;
      lastX: number;
      lastY: number;
      velocityX: number;
      velocityY: number;
    }
  | {
      readonly kind: 'camera';
      readonly pointerId: number;
      readonly startClientX: number;
      readonly startClientY: number;
      readonly startCameraX: number;
      readonly startCameraY: number;
    };

interface GraphRebound {
  readonly node: BrainGraphNode;
  readonly anchorX: number;
  readonly anchorY: number;
  elapsedMs: number;
}

function centeredCamera(nodes: readonly BrainGraphNode[], viewport: GraphViewport): GraphCamera {
  const minX = Math.min(...nodes.map((node) => node.x));
  const maxX = Math.max(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxY = Math.max(...nodes.map((node) => node.y));
  const contentWidth = Math.max(maxX - minX, 1);
  const contentHeight = Math.max(maxY - minY, 1);
  const scale = Math.max(
    0.35,
    Math.min(1, (viewport.width - 160) / contentWidth, (viewport.height - 140) / contentHeight),
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
  context.fillStyle = '#141414';
  context.fillRect(0, 0, viewport.width, viewport.height);
  context.save();
  context.translate(camera.x, camera.y);
  context.scale(camera.scale, camera.scale);

  const highlightedIds = new Set<string>();
  if (state.hoveredId) {
    highlightedIds.add(state.hoveredId);
    for (const edge of state.edges) {
      if (edge.sourcePageId === state.hoveredId) highlightedIds.add(edge.targetPageId);
      if (edge.targetPageId === state.hoveredId) highlightedIds.add(edge.sourcePageId);
    }
  }

  for (const edge of state.edges) {
    const source = state.nodes[edge.sourceIndex]!;
    const target = state.nodes[edge.targetIndex]!;
    const highlighted =
      state.hoveredId === edge.sourcePageId || state.hoveredId === edge.targetPageId;
    context.beginPath();
    context.moveTo(source.x, source.y);
    context.lineTo(target.x, target.y);
    context.strokeStyle = highlighted ? '#3b82f6' : '#4b5563';
    context.lineWidth = (highlighted ? 2.5 : 1.5) / camera.scale;
    context.stroke();
  }

  for (const node of state.nodes) {
    const highlighted = highlightedIds.has(node.id);
    context.beginPath();
    context.arc(node.x, node.y, highlighted ? node.radius + 2 : node.radius, 0, Math.PI * 2);
    context.fillStyle = highlighted ? '#3b82f6' : '#d0d0d0';
    context.fill();
    context.font = `${12 / camera.scale}px sans-serif`;
    context.textAlign = 'center';
    context.fillStyle = highlighted ? '#ffffff' : '#9e9e9e';
    const label = node.label.length > 22 ? `${node.label.slice(0, 20)}...` : node.label;
    context.fillText(label, node.x, node.y + node.radius + 14 / camera.scale);
  }
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
    if (Math.hypot(x - node.x, y - node.y) < node.radius + 6 / scale) return node;
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
  const previousPhysicsTimeRef = useRef<number | null>(null);
  const reboundRef = useRef<GraphRebound | null>(null);
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
    previousPhysicsTimeRef.current = null;
    reboundRef.current = null;
  }, []);

  const stopCameraAnimation = useCallback(() => {
    if (cameraFrameRef.current !== null) {
      cancelAnimationFrame(cameraFrameRef.current);
      cameraFrameRef.current = null;
    }
  }, []);

  const animatePhysics = useCallback(
    (timestamp: number) => {
      const state = stateRef.current;
      const rebound = reboundRef.current;
      if (!state.dragging && !rebound) {
        physicsFrameRef.current = null;
        previousPhysicsTimeRef.current = null;
        return;
      }
      const previousTime = previousPhysicsTimeRef.current;
      const timeStep =
        previousTime === null
          ? 1
          : Math.min(1.5, Math.max(0.5, (timestamp - previousTime) / 16.67));
      previousPhysicsTimeRef.current = timestamp;
      if (rebound) {
        rebound.node.vx += (rebound.anchorX - rebound.node.x) * 0.12 * timeStep;
        rebound.node.vy += (rebound.anchorY - rebound.node.y) * 0.12 * timeStep;
        rebound.elapsedMs += 16.67 * timeStep;
      }
      simulateBrainGraph(
        state.nodes,
        state.edges,
        state.dragging,
        GRAPH_WIDTH,
        GRAPH_HEIGHT,
        timeStep,
      );
      if (rebound) {
        const displacement = Math.hypot(
          rebound.node.x - rebound.anchorX,
          rebound.node.y - rebound.anchorY,
        );
        const speed = Math.hypot(rebound.node.vx, rebound.node.vy);
        if (shouldStopGraphRebound(rebound.elapsedMs, displacement, speed)) {
          rebound.node.x = rebound.anchorX;
          rebound.node.y = rebound.anchorY;
          rebound.node.vx = 0;
          rebound.node.vy = 0;
          reboundRef.current = null;
        }
      }
      draw();
      if (state.dragging || reboundRef.current) {
        physicsFrameRef.current = requestAnimationFrame(animatePhysics);
      } else {
        physicsFrameRef.current = null;
        previousPhysicsTimeRef.current = null;
      }
    },
    [draw],
  );

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
      const nextScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.scale * factor));
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
  }, [graphState, centerGraph, stopPhysics]);

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
    stopPhysics();
    stateRef.current.dragging = null;
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
        lastX: point.x,
        lastY: point.y,
        velocityX: 0,
        velocityY: 0,
      };
      startPhysics();
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
        const deltaX = point.x - interaction.lastX;
        const deltaY = point.y - interaction.lastY;
        interaction.velocityX = interaction.velocityX * 0.35 + deltaX * 0.65;
        interaction.velocityY = interaction.velocityY * 0.35 + deltaY * 0.65;
        interaction.lastX = point.x;
        interaction.lastY = point.y;
        interaction.node.x = point.x;
        interaction.node.y = point.y;
        interaction.node.vx = 0;
        interaction.node.vy = 0;
        if (Math.hypot(point.x - interaction.startX, point.y - interaction.startY) > 3) {
          interaction.moved = true;
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
      if (allowOpen && !interaction.moved) {
        stopPhysics();
        if (interaction.node.document) onOpenDocument(interaction.node.document);
        else onOpenWelcome();
      } else if (allowOpen && interaction.moved) {
        interaction.node.vx = interaction.velocityX;
        interaction.node.vy = interaction.velocityY;
        reboundRef.current = {
          node: interaction.node,
          anchorX: interaction.node.x,
          anchorY: interaction.node.y,
          elapsedMs: 0,
        };
        startPhysics();
      } else {
        stopPhysics();
      }
    }
    draw();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#141414]" data-testid="graph-view">
      <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
        <div className="flex items-center rounded-md border border-[#303030] bg-[#1a1a1a]/90 p-0.5 backdrop-blur">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-[#c8c8c8]"
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
            className="h-7 min-w-14 px-2 text-[11px] text-[#c8c8c8]"
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
            className="h-7 w-7 text-[#c8c8c8]"
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
          className="flex h-8 items-center gap-1.5 rounded-md border border-[#303030] bg-[#1a1a1a]/90 px-2.5 text-xs font-medium text-[#c8c8c8] backdrop-blur transition-colors hover:border-[#454545] hover:bg-[#242424] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3b82f6]"
          data-testid="center-graph"
          aria-label={t('brain.centerGraph')}
          title={t('brain.centerGraph')}
        >
          <i className="ti ti-focus-centered" aria-hidden="true" />
          <span>{t('brain.centerGraph')}</span>
        </button>
        <div className="rounded-md border border-[#2a2a2a] bg-[#1a1a1a]/90 px-3 py-1.5 text-xs text-[#a0a0a0] backdrop-blur">
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
          zoomAt(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, point.x, point.y);
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
