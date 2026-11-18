import type { E2eActionMap, E2eMapPage } from './e2e-types.js';

/** Sizes of the action map, in pixels at 100% zoom. */
export const MAP_CARD = { width: 220, height: 196, gapX: 96, gapY: 28, startWidth: 110 } as const;

export interface MapNode {
  readonly page: E2eMapPage;
  readonly x: number;
  readonly y: number;
}

export interface MapEdge {
  readonly id: string;
  readonly testIds: readonly string[];
  /** SVG path from the source card (or the start of the run) to the target card. */
  readonly d: string;
  /** A test that went this way failed on the page it leads to. */
  readonly failed: boolean;
}

export interface MapLayout {
  readonly nodes: readonly MapNode[];
  readonly edges: readonly MapEdge[];
  readonly width: number;
  readonly height: number;
  /** Where the run starts: the point the first edges leave from. */
  readonly start: { readonly x: number; readonly y: number };
}

/**
 * Places the pages of a run in columns: a page sits as far to the right as the earliest moment
 * any test got to it, so the map reads from the start of the run to its last pages.
 */
export function layoutActionMap(map: E2eActionMap): MapLayout {
  const columns: E2eMapPage[][] = [];
  for (const page of map.pages) {
    const positions = map.tests
      .map((test) => test.path.indexOf(page.id))
      .filter((position) => position >= 0);
    // A page no test path goes through (only touched) stays in the first column.
    const column = positions.length ? Math.min(...positions) : 0;
    (columns[column] ??= []).push(page);
  }
  const filled = columns.filter(Boolean);
  const rows = Math.max(1, ...filled.map((column) => column.length));
  const rowHeight = MAP_CARD.height + MAP_CARD.gapY;
  const height = rows * rowHeight - MAP_CARD.gapY;
  const nodes: MapNode[] = [];
  filled.forEach((column, index) => {
    const offset = ((rows - column.length) * rowHeight) / 2;
    column.forEach((page, row) =>
      nodes.push({
        page,
        x: MAP_CARD.startWidth + index * (MAP_CARD.width + MAP_CARD.gapX),
        y: offset + row * rowHeight,
      }),
    );
  });
  const byId = new Map(nodes.map((node) => [node.page.id, node]));
  const start = { x: MAP_CARD.startWidth - MAP_CARD.gapX / 2, y: height / 2 };
  const edges: MapEdge[] = [];
  for (const edge of map.edges) {
    const target = byId.get(edge.to);
    const source = edge.from === null ? null : byId.get(edge.from);
    if (!target || source === undefined) continue;
    const from = source
      ? { x: source.x + MAP_CARD.width, y: source.y + MAP_CARD.height / 2 }
      : start;
    const to = { x: target.x, y: target.y + MAP_CARD.height / 2 };
    const bend = Math.max(40, Math.abs(to.x - from.x) / 2);
    edges.push({
      id: `${edge.from ?? ''}>${edge.to}`,
      testIds: edge.testIds,
      d: `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`,
      failed: edge.testIds.some((id) => target.page.failedTestIds.includes(id)),
    });
  }
  return {
    nodes,
    edges,
    width: MAP_CARD.startWidth + filled.length * (MAP_CARD.width + MAP_CARD.gapX),
    height,
    start,
  };
}
