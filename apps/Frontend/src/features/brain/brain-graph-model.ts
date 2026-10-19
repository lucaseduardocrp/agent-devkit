import type { KnowledgeDocumentDto } from '../../lib/api-client.js';

export const GRAPH_WIDTH = 1000;
export const GRAPH_HEIGHT = 600;
export const WELCOME_NODE_ID = '__welcome__';

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
  const nodes: BrainGraphNode[] = [
    {
      id: WELCOME_NODE_ID,
      label: 'Welcome',
      x: GRAPH_WIDTH / 2,
      y: GRAPH_HEIGHT / 2,
      vx: 0,
      vy: 0,
      radius: 7,
    },
    ...documents.map((document, index) => {
      const angle = (index / Math.max(documents.length, 1)) * Math.PI * 2 - Math.PI / 2;
      return {
        id: document.pageId,
        document,
        label: document.title,
        x: GRAPH_WIDTH / 2 + Math.cos(angle) * 320,
        y: GRAPH_HEIGHT / 2 + Math.sin(angle) * 200,
        vx: 0,
        vy: 0,
        radius: 6,
      };
    }),
  ];
  const nodeIndexById = new Map(nodes.map((node, index) => [node.id, index]));
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
  const degrees = new Array<number>(nodes.length).fill(0);
  for (const edge of edges) {
    degrees[edge.sourceIndex]! += 1;
    degrees[edge.targetIndex]! += 1;
  }
  return {
    nodes: nodes.map((node, index) => ({
      ...node,
      // Grow subtly in steps of ten unique connections, keeping large hubs bounded.
      radius: Math.min(24, node.radius + Math.floor(degrees[index]! / 10)),
    })),
    edges,
    dragging: null,
    hoveredId: null,
  };
}

export function simulateBrainGraph(
  nodes: BrainGraphNode[],
  edges: readonly BrainGraphIndexedEdge[],
  dragging: BrainGraphNode | null,
  width = GRAPH_WIDTH,
  height = GRAPH_HEIGHT,
  timeStep = 1,
): void {
  const centerX = width / 2;
  const centerY = height / 2;

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (node === dragging) continue;
    let forceX = (centerX - node.x) * 0.0008;
    let forceY = (centerY - node.y) * 0.0008;

    for (let otherIndex = 0; otherIndex < nodes.length; otherIndex += 1) {
      if (index === otherIndex) continue;
      const other = nodes[otherIndex]!;
      const deltaX = node.x - other.x;
      const deltaY = node.y - other.y;
      const distanceSquared = Math.max(deltaX * deltaX + deltaY * deltaY, 1);
      const distance = Math.sqrt(distanceSquared);
      const repulsion = 4500 / distanceSquared;
      forceX += (deltaX / distance) * repulsion;
      forceY += (deltaY / distance) * repulsion;
    }
    node.vx += forceX * timeStep;
    node.vy += forceY * timeStep;
  }

  for (const edge of edges) {
    const source = nodes[edge.sourceIndex];
    const target = nodes[edge.targetIndex];
    /* v8 ignore next -- indexed edges are validated when state is created */
    if (!source || !target) continue;
    const deltaX = target.x - source.x;
    const deltaY = target.y - source.y;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY) + 0.001;
    const force = (distance - 130) * 0.012;
    const forceX = (deltaX / distance) * force;
    const forceY = (deltaY / distance) * force;
    if (source !== dragging) {
      source.vx += forceX * timeStep;
      source.vy += forceY * timeStep;
    }
    if (target !== dragging) {
      target.vx -= forceX * timeStep;
      target.vy -= forceY * timeStep;
    }
  }

  for (const node of nodes) {
    if (node === dragging) continue;
    const damping = Math.pow(0.82, timeStep);
    node.vx *= damping;
    node.vy *= damping;
    const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
    if (speed > 6) {
      node.vx = (node.vx / speed) * 6;
      node.vy = (node.vy / speed) * 6;
    }
    node.x += node.vx * timeStep;
    node.y += node.vy * timeStep;
    const margin = node.radius + 8;
    if (node.x < margin) {
      node.x = margin;
      node.vx *= -0.4;
    }
    if (node.x > width - margin) {
      node.x = width - margin;
      node.vx *= -0.4;
    }
    if (node.y < margin) {
      node.y = margin;
      node.vy *= -0.4;
    }
    if (node.y > height - margin) {
      node.y = height - margin;
      node.vy *= -0.4;
    }
  }
}

export function shouldStopGraphRebound(
  elapsedMs: number,
  displacement: number,
  speed: number,
): boolean {
  return elapsedMs >= 700 || (elapsedMs >= 180 && displacement < 0.35 && speed < 0.08);
}
