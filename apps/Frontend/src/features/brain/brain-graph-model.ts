import type { KnowledgeDocumentDto } from '../../lib/api-client.js';

export const GRAPH_WIDTH = 1000;
export const GRAPH_HEIGHT = 600;
export const WELCOME_NODE_ID = '__welcome__';

export const ALPHA_MIN = 0.001;
export const DRAG_ALPHA_TARGET = 0.3;
const ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / 300);
const VELOCITY_RETENTION = 0.6;
const CENTER_STRENGTH = 0.03;
const REPEL_STRENGTH = 260;
const REPEL_MAX_DISTANCE = 600;
const LINK_DISTANCE = 60;
const GOLDEN_ANGLE = 2.399963229728653;

export interface BrainGraphEdge {
  readonly sourcePageId: string;
  readonly targetPageId: string;
}

export interface BrainGraphNode {
  readonly id: string;
  readonly document?: KnowledgeDocumentDto;
  readonly label: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  readonly radius: number;
  readonly degree: number;
}

export interface BrainGraphIndexedEdge {
  readonly sourceIndex: number;
  readonly targetIndex: number;
  readonly sourcePageId: string;
  readonly targetPageId: string;
}

export interface BrainGraphState {
  nodes: BrainGraphNode[];
  edges: BrainGraphIndexedEdge[];
  dragging: BrainGraphNode | null;
  hoveredId: string | null;
  /** Simulation "temperature" (d3-force style); the graph rests once it drops below ALPHA_MIN. */
  alpha: number;
  alphaTarget: number;
}

export function buildWikilinkEdges(
  documents: readonly KnowledgeDocumentDto[],
): readonly BrainGraphEdge[] {
  const byReference = new Map<string, KnowledgeDocumentDto>();
  for (const document of documents) {
    byReference.set(document.pageId.toLocaleLowerCase(), document);
    byReference.set(document.title.trim().toLocaleLowerCase(), document);
  }
  const edges = new Map<string, BrainGraphEdge>();
  for (const source of documents) {
    for (const match of (source.content ?? '').matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
      const target = byReference.get(match[1]!.trim().toLocaleLowerCase());
      if (!target || target.pageId === source.pageId) continue;
      const key = [source.pageId, target.pageId].sort().join(':');
      edges.set(key, { sourcePageId: source.pageId, targetPageId: target.pageId });
    }
  }
  return [...edges.values()];
}

export function createBrainGraphState(
  documents: readonly KnowledgeDocumentDto[],
  relations: readonly BrainGraphEdge[] = [],
): BrainGraphState {
  const seeds: { id: string; label: string; document?: KnowledgeDocumentDto }[] = [
    { id: WELCOME_NODE_ID, label: 'Welcome' },
    ...documents.map((document) => ({
      id: document.pageId,
      label: document.title,
      document,
    })),
  ];
  const nodeIndexById = new Map(seeds.map((node, index) => [node.id, index]));
  const uniqueEdges = new Map<string, BrainGraphEdge>();
  const documentIds = new Set(documents.map((document) => document.pageId));
  for (const edge of [...buildWikilinkEdges(documents), ...relations]) {
    if (
      edge.sourcePageId === edge.targetPageId ||
      !documentIds.has(edge.sourcePageId) ||
      !documentIds.has(edge.targetPageId)
    )
      continue;
    const key = JSON.stringify([edge.sourcePageId, edge.targetPageId].sort());
    uniqueEdges.set(key, edge);
  }
  const edges = [...uniqueEdges.values()].map((edge) => ({
    ...edge,
    sourceIndex: nodeIndexById.get(edge.sourcePageId)!,
    targetIndex: nodeIndexById.get(edge.targetPageId)!,
  }));
  const degrees = new Array<number>(seeds.length).fill(0);
  for (const edge of edges) {
    degrees[edge.sourceIndex]! += 1;
    degrees[edge.targetIndex]! += 1;
  }
  const state: BrainGraphState = {
    nodes: seeds.map((seed, index) => {
      // Deterministic phyllotaxis scatter: a stable starting point for the force layout.
      const angle = index * GOLDEN_ANGLE;
      const distance = 16 * Math.sqrt(index + 0.5);
      const degree = degrees[index]!;
      return {
        ...seed,
        x: GRAPH_WIDTH / 2 + Math.cos(angle) * distance,
        y: GRAPH_HEIGHT / 2 + Math.sin(angle) * distance,
        vx: 0,
        vy: 0,
        degree,
        // Obsidian-like: small dots that grow with the number of connections.
        radius: Math.min(16, 4 + Math.sqrt(degree) * 1.3),
      };
    }),
    edges,
    dragging: null,
    hoveredId: null,
    alpha: 1,
    alphaTarget: 0,
  };
  // Pre-settle synchronously (bounded by graph size) so the first paint is already organised.
  const warmupTicks = Math.min(150, Math.max(12, Math.floor(2_000_000 / state.nodes.length ** 2)));
  for (let tick = 0; tick < warmupTicks; tick += 1) stepBrainGraph(state);
  return state;
}

/**
 * Advances the force simulation by one tick (d3-force semantics: centre gravity,
 * many-body repulsion, degree-weighted link springs, velocity decay, alpha cooling).
 * Returns whether the graph is still moving and another frame is needed.
 */
export function stepBrainGraph(state: BrainGraphState): boolean {
  const { nodes, edges, dragging } = state;
  state.alpha += (state.alphaTarget - state.alpha) * ALPHA_DECAY;
  const alpha = state.alpha;
  const centerX = GRAPH_WIDTH / 2;
  const centerY = GRAPH_HEIGHT / 2;

  for (const node of nodes) {
    node.vx += (centerX - node.x) * CENTER_STRENGTH * alpha;
    node.vy += (centerY - node.y) * CENTER_STRENGTH * alpha;
  }

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    for (let otherIndex = index + 1; otherIndex < nodes.length; otherIndex += 1) {
      const other = nodes[otherIndex]!;
      const deltaX = other.x - node.x;
      const deltaY = other.y - node.y;
      const distanceSquared = deltaX * deltaX + deltaY * deltaY;
      if (distanceSquared > REPEL_MAX_DISTANCE * REPEL_MAX_DISTANCE) continue;
      const weight = (REPEL_STRENGTH * alpha) / Math.max(distanceSquared, 1);
      node.vx -= deltaX * weight;
      node.vy -= deltaY * weight;
      other.vx += deltaX * weight;
      other.vy += deltaY * weight;
    }
  }

  for (const edge of edges) {
    const source = nodes[edge.sourceIndex]!;
    const target = nodes[edge.targetIndex]!;
    const deltaX = target.x + target.vx - source.x - source.vx;
    const deltaY = target.y + target.vy - source.y - source.vy;
    const distance = Math.hypot(deltaX, deltaY) || 1e-6;
    const strength = 1 / Math.min(source.degree, target.degree);
    const pull = ((distance - LINK_DISTANCE) / distance) * alpha * strength;
    const bias = source.degree / (source.degree + target.degree);
    target.vx -= deltaX * pull * bias;
    target.vy -= deltaY * pull * bias;
    source.vx += deltaX * pull * (1 - bias);
    source.vy += deltaY * pull * (1 - bias);
  }

  for (const node of nodes) {
    if (node === dragging) {
      node.vx = 0;
      node.vy = 0;
      continue;
    }
    node.vx *= VELOCITY_RETENTION;
    node.vy *= VELOCITY_RETENTION;
    node.x += node.vx;
    node.y += node.vy;
  }
  return state.alpha >= ALPHA_MIN;
}
